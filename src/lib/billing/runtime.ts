/**
 * Database half of the commercial domain: invoice numbers, the usage ledger,
 * price versions, CMS ingest, entitlement projection, spend policy and
 * vendor cost. Rating arithmetic stays in `rating/engine.ts`.
 */
import { randomBytes } from "node:crypto";
import type { PoolClient } from "../db";
import { getPool, query, withTenant, withoutTenantScope } from "../db";
import { encryptSecret, resolveEncryptionKey } from "../integrations/secrets";
import { meterByKey } from "./catalog/meters";
import { billingLog } from "./observability";
import {
  calculateCommercialQuote,
  rateQuantity,
  selectPriceVersion,
  type CommercialQuoteAddonLine,
  type CommercialQuoteResult,
  type PriceVersionPoint,
} from "./rating/engine";
import { evaluateSpend, type SpendEvaluation, type SpendLimitAction } from "./policy/spend";
import { tehranMonthWindow } from "../ai-plan-allowance";
import { verifyBillingServiceRequest as verifyBillingServiceRequestV1 } from "./auth/verify-service-request";
import type { BillingServiceScope } from "./auth/sign";
import { parseUsageBatchEnvelope, parseUsageEvent, type UsageEventV1 } from "./contract/v1";
import { validateUsageEvent } from "./usage/validate";

export { verifyBillingServiceRequestV1 as verifyBillingServiceRequest };
export type { BillingServiceScope };

export interface StoredPriceVersion extends PriceVersionPoint {
  id: string;
  targetType: string;
  targetKey: string;
  unit: string;
  metadata: Record<string, unknown>;
}

export async function allocateInvoiceNumber(client: PoolClient, now: Date = new Date()): Promise<string> {
  const period = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const { rows } = await client.query<{ last_value: string; prefix: string }>(
    `INSERT INTO billing_invoice_counters (period_key, last_value)
     VALUES ($1, 1)
     ON CONFLICT (period_key) DO UPDATE
       SET last_value = billing_invoice_counters.last_value + 1
     RETURNING last_value, (SELECT invoice_prefix FROM billing_commercial_settings WHERE id) AS prefix`,
    [period],
  );
  const prefix = rows[0]?.prefix || "INV";
  const seq = String(rows[0]?.last_value ?? "1").padStart(4, "0");
  return `${prefix}-${period}-${seq}`;
}

export interface AppendUsageInput {
  eventId: string;
  businessId: string;
  meterKey: string;
  source: string;
  quantity: number;
  unit: string;
  occurredAt?: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  resource?: string | null;
  resourceId?: string | null;
  dimensions?: Record<string, unknown>;
  sourceReference?: string | null;
  eventKind?: "usage" | "correction";
  ratedAmountRial?: number | null;
  priceVersionId?: string | null;
}

export type AppendUsageResult =
  | { status: "accepted"; id: string }
  | { status: "duplicate"; id: string | null }
  | { status: "rejected"; code: string };

/**
 * Append one usage event. The unique (source, event_id) index is the
 * idempotency key. A duplicate does not change the stored quantity.
 */
export async function appendUsageEvent(input: AppendUsageInput, client?: PoolClient): Promise<AppendUsageResult> {
  const check = validateUsageEvent(input);
  if (!check.ok) return { status: "rejected", code: check.code };
  const run = async (db: Sql) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO billing_usage_events
         (event_id, business_id, meter_key, source, resource_type, resource_id,
          quantity, unit, event_kind, occurred_at, period_start, period_end,
          dimensions, source_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10::timestamptz, now()), $11,$12,$13::jsonb,$14)
       ON CONFLICT (source, event_id) DO NOTHING
       RETURNING id`,
      [
        input.eventId,
        input.businessId,
        input.meterKey,
        input.source,
        input.resource ?? null,
        input.resourceId ?? null,
        input.quantity,
        input.unit,
        input.eventKind ?? "usage",
        input.occurredAt ?? null,
        input.periodStart ?? null,
        input.periodEnd ?? null,
        JSON.stringify(input.dimensions ?? {}),
        input.sourceReference ?? null,
      ],
    );
    if (!rows[0]) {
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM billing_usage_events WHERE source = $1 AND event_id = $2`,
        [input.source, input.eventId],
      );
      return { status: "duplicate" as const, id: existing.rows[0]?.id ?? null };
    }
    const occurredAtIso = input.occurredAt ?? new Date().toISOString();
    const activePrice =
      input.priceVersionId != null
        ? null
        : await priceAtDb(db, "meter", input.meterKey, occurredAtIso);
    const resolvedPriceVersionId = input.priceVersionId ?? activePrice?.id ?? null;

    if (input.ratedAmountRial != null) {
      await db.query(
        `INSERT INTO billing_usage_ratings
           (usage_event_id, business_id, price_version_id, rated_amount_rial, allowance_quantity, overage_quantity)
         VALUES ($1,$2,$3,$4,0,$5)
         ON CONFLICT (usage_event_id) DO NOTHING`,
        [rows[0].id, input.businessId, resolvedPriceVersionId, Math.max(0, Math.floor(input.ratedAmountRial)), input.quantity],
      );
    } else if (activePrice) {
      const rated = await rateMeterEventDb(db, {
        businessId: input.businessId,
        meterKey: input.meterKey,
        eventId: rows[0].id,
        quantity: input.quantity,
        occurredAtIso,
        price: activePrice,
      });
      await db.query(
        `INSERT INTO billing_usage_ratings
           (usage_event_id, business_id, price_version_id, rated_amount_rial, allowance_quantity, overage_quantity)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (usage_event_id) DO NOTHING`,
        [
          rows[0].id,
          input.businessId,
          activePrice.id,
          rated.amountRial,
          rated.includedConsumed,
          rated.overageQuantity,
        ],
      );
    }
    await refreshDailyRollup(db, input.businessId, input.meterKey, occurredAtIso);
    return { status: "accepted" as const, id: rows[0].id };
  };
  if (client) return run(client as unknown as Sql);
  const pooled = await getPool().connect();
  try {
    await pooled.query("BEGIN");
    const result = await run(pooled);
    await pooled.query("COMMIT");
    return result;
  } catch (error) {
    await pooled.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    pooled.release();
  }
}

type Sql = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};

async function refreshDailyRollup(
  db: Sql,
  businessId: string,
  meterKey: string,
  occurredAtIso: string,
): Promise<void> {
  const day = occurredAtIso.slice(0, 10);
  await db.query(
    `INSERT INTO billing_usage_rollups_daily (business_id, meter_key, day, quantity, event_count)
     SELECT business_id, meter_key, $3::date, COALESCE(SUM(quantity), 0), COUNT(*)
       FROM billing_usage_events
      WHERE business_id = $1 AND meter_key = $2
        AND occurred_at >= $3::date AND occurred_at < ($3::date + interval '1 day')
      GROUP BY business_id, meter_key
     ON CONFLICT (business_id, meter_key, day) DO UPDATE
       SET quantity = EXCLUDED.quantity,
           event_count = EXCLUDED.event_count,
           updated_at = now()`,
    [businessId, meterKey, day],
  );
}

export async function listEffectivePrices(
  targetType: string,
  targetKey: string,
  db: Sql = { query },
): Promise<StoredPriceVersion[]> {
  const { rows } = await db.query<{
    id: string;
    target_type: string;
    target_key: string;
    unit: string;
    unit_amount_rial: string;
    unit_size: string;
    effective_from: Date | string;
    effective_until: Date | string | null;
    version: number;
    metadata: Record<string, unknown>;
  }>(
    `SELECT id, target_type, target_key, unit, unit_amount_rial, unit_size,
            effective_from, effective_until, version, metadata
       FROM billing_price_versions
      WHERE target_type = $1 AND target_key = $2
      ORDER BY version DESC`,
    [targetType, targetKey],
  );
  return rows.map((row) => ({
    id: row.id,
    targetType: row.target_type,
    targetKey: row.target_key,
    unit: row.unit,
    unitAmountRial: Number(row.unit_amount_rial),
    unitSize: Number(row.unit_size),
    version: row.version,
    effectiveFrom: row.effective_from instanceof Date ? row.effective_from.toISOString() : new Date(row.effective_from).toISOString(),
    effectiveUntil: row.effective_until
      ? row.effective_until instanceof Date
        ? row.effective_until.toISOString()
        : new Date(row.effective_until).toISOString()
      : null,
    metadata: row.metadata ?? {},
  }));
}

export async function priceAt(targetType: string, targetKey: string, atIso: string): Promise<StoredPriceVersion | null> {
  const versions = await listEffectivePrices(targetType, targetKey);
  return selectPriceVersion(versions, atIso);
}

async function priceAtDb(
  db: Sql,
  targetType: string,
  targetKey: string,
  atIso: string,
): Promise<StoredPriceVersion | null> {
  const versions = await listEffectivePrices(targetType, targetKey, db);
  return selectPriceVersion(versions, atIso);
}

async function rateMeterEventDb(
  db: Sql,
  input: {
    businessId: string;
    meterKey: string;
    eventId: string;
    quantity: number;
    occurredAtIso: string;
    price: StoredPriceVersion;
  },
): Promise<{ includedConsumed: number; overageQuantity: number; amountRial: number }> {
  const window = tehranMonthWindow(new Date(input.occurredAtIso));
  const { rows } = await db.query<{
    included_quantity: string | null;
    overage_enabled: boolean | null;
    hard_limit: string | null;
    used_before: string;
    rounding: string | null;
  }>(
    `SELECT a.included_quantity::text AS included_quantity,
            a.overage_enabled,
            a.hard_limit::text AS hard_limit,
            COALESCE((
              SELECT SUM(e.quantity)
                FROM billing_usage_events e
               WHERE e.business_id = $1
                 AND e.meter_key = $2
                 AND e.id <> $3
                 AND e.occurred_at >= $4::timestamptz
                 AND e.occurred_at < $5::timestamptz
            ), 0)::text AS used_before,
            cs.rounding
       FROM businesses b
       LEFT JOIN billing_plan_meter_allowances a
              ON a.plan_key = b.plan AND a.meter_key = $2
       LEFT JOIN billing_commercial_settings cs ON cs.id = true
      WHERE b.id = $1`,
    [
      input.businessId,
      input.meterKey,
      input.eventId,
      window.startUtc.toISOString(),
      window.nextStartUtc.toISOString(),
    ],
  );
  const row = rows[0];
  const includedTotal = row?.included_quantity == null ? null : Number(row.included_quantity);
  const usedBefore = Number(row?.used_before ?? 0);
  const includedRemaining =
    includedTotal == null ? null : Math.max(0, includedTotal - usedBefore);
  const hardLimitTotal = row?.hard_limit == null ? null : Number(row.hard_limit);
  const hardLimitRemaining =
    hardLimitTotal == null ? null : Math.max(0, hardLimitTotal - usedBefore);
  const rounding = row?.rounding === "floor" ? "floor" : "ceil";

  const rated = rateQuantity({
    quantity: Math.max(0, Math.floor(input.quantity)),
    includedRemaining,
    overageEnabled: row?.overage_enabled ?? true,
    hardLimit: hardLimitRemaining,
    price: {
      unitAmountRial: input.price.unitAmountRial,
      unitSize: input.price.unitSize,
    },
    rounding,
  });
  return {
    includedConsumed: rated.includedConsumed,
    overageQuantity: rated.overageQuantity,
    amountRial: rated.amountRial,
  };
}

/**
 * Publish a new price version and close the previous open window. The amount
 * on an existing version is immutable; only `effective_until` moves.
 */
export async function publishPriceVersion(input: {
  targetType: "meter" | "plan" | "addon" | "capability";
  targetKey: string;
  unit: string;
  unitAmountRial: number;
  unitSize?: number;
  metadata?: Record<string, unknown>;
  effectiveFrom?: string;
  createdBy?: string | null;
}): Promise<void> {
  const amount = Math.floor(input.unitAmountRial);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("bad_price");
  const from = input.effectiveFrom ?? new Date().toISOString();
  await query(
    `UPDATE billing_price_versions
        SET effective_until = $3
      WHERE target_type = $1 AND target_key = $2 AND effective_until IS NULL AND effective_from < $3::timestamptz`,
    [input.targetType, input.targetKey, from],
  );
  await query(
    `INSERT INTO billing_price_versions
       (target_type, target_key, unit, unit_amount_rial, unit_size, effective_from, version, metadata, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz,
             COALESCE((SELECT MAX(version) + 1 FROM billing_price_versions
                        WHERE target_type = $1 AND target_key = $2), 1),
             $7::jsonb, $8)`,
    [
      input.targetType,
      input.targetKey,
      input.unit,
      amount,
      input.unitSize ?? 1,
      from,
      JSON.stringify(input.metadata ?? {}),
      input.createdBy ?? null,
    ],
  );
}

export async function syncAiAllowance(planKey: string, includedRial: number | null): Promise<void> {
  if (includedRial == null || includedRial <= 0) {
    await query(`DELETE FROM billing_plan_meter_allowances WHERE plan_key = $1 AND meter_key = 'ai.credit'`, [planKey]);
    return;
  }
  await query(
    `INSERT INTO billing_plan_meter_allowances
       (plan_key, meter_key, included_quantity, overage_enabled, reset_period)
     VALUES ($1, 'ai.credit', $2, true, 'month')
     ON CONFLICT (plan_key, meter_key) DO UPDATE
       SET included_quantity = EXCLUDED.included_quantity, updated_at = now()`,
    [planKey, includedRial],
  );
}

// ---------------------------------------------------------------------------
// CMS service credential — scope is only billing.usage.write
// ---------------------------------------------------------------------------

export async function createBillingServiceCredential(
  label: string,
  scope: BillingServiceScope = "billing.usage.write",
): Promise<{ keyId: string; secret: string }> {
  const keyId = `cms_${randomBytes(8).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  const secretEnc = encryptSecret(secret, resolveEncryptionKey(process.env));
  await query(
    `INSERT INTO billing_service_credentials (key_id, secret_enc, scope, label)
     VALUES ($1, $2, $3, $4)`,
    [keyId, secretEnc, scope, label.trim() || "eshobe-cms"],
  );
  billingLog("billing.credential.created", { keyId, scope });
  return { keyId, secret };
}

export async function revokeBillingServiceCredential(keyId: string): Promise<void> {
  await query(
    `UPDATE billing_service_credentials SET revoked_at = now() WHERE key_id = $1 AND revoked_at IS NULL`,
    [keyId],
  );
  billingLog("billing.credential.revoked", { keyId });
}

export type IngestEvent = UsageEventV1;

export type IngestEventResult = {
  eventId: string;
  status: "accepted" | "duplicate" | "rejected";
  reason?: string;
};

export interface IngestBatchResult {
  contractVersion: number;
  results: IngestEventResult[];
  accepted: number;
  duplicates: number;
}

/**
 * Ingest a CMS batch. `siteId` is resolved to a business here. A business id
 * on the event, if a caller sent one, is ignored.
 */
export async function ingestCmsUsageBatchFromContract(batch: { events: UsageEventV1[] }): Promise<IngestBatchResult> {
  const results: IngestEventResult[] = [];
  let accepted = 0;
  let duplicates = 0;
  for (const event of batch.events) {
    const businessId = await resolveCmsSiteBusiness(event.siteId);
    if (!businessId) {
      results.push({ eventId: event.eventId, status: "rejected", reason: "unknown_site" });
      continue;
    }
    const appended = await withTenant(businessId, () =>
      appendUsageEvent({
        eventId: event.eventId,
        businessId,
        meterKey: event.meterKey,
        source: "eshobe-cms",
        quantity: event.quantity,
        unit: event.unit,
        occurredAt: event.occurredAt,
        periodStart: event.periodStart,
        periodEnd: event.periodEnd,
        resource: event.resourceType ?? "site",
        resourceId: event.resourceId ?? event.siteId,
        dimensions: event.dimensions,
        sourceReference: event.siteId,
        eventKind: event.kind === "correction" ? "correction" : "usage",
      }),
    );
    if (appended.status === "accepted") {
      accepted += 1;
      results.push({ eventId: event.eventId, status: "accepted" });
    } else if (appended.status === "duplicate") {
      duplicates += 1;
      results.push({ eventId: event.eventId, status: "duplicate" });
    } else {
      results.push({ eventId: event.eventId, status: "rejected", reason: appended.code.toLowerCase() });
    }
  }
  billingLog("billing.usage.ingest", {
    source: "eshobe-cms",
    accepted,
    duplicates,
    rejected: results.filter((row) => row.status === "rejected").length,
  });
  return { contractVersion: 1, results, accepted, duplicates };
}

function ingestEventIdFromRaw(raw: unknown): string {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const eventId = (raw as Record<string, unknown>).eventId;
    if (typeof eventId === "string" && eventId.length > 0) return eventId;
  }
  return "unknown";
}

export async function ingestCmsUsageBatchBody(body: unknown): Promise<IngestBatchResult | { error: string }> {
  const envelope = parseUsageBatchEnvelope(body);
  if ("error" in envelope) {
    return { error: envelope.error.code };
  }

  const slots: (IngestEventResult | null)[] = [];
  const toIngest: UsageEventV1[] = [];

  for (const raw of envelope.envelope.events) {
    const parsed = parseUsageEvent(raw);
    if ("error" in parsed) {
      slots.push({
        eventId: ingestEventIdFromRaw(raw),
        status: "rejected",
        reason: parsed.error.code,
      });
      continue;
    }
    slots.push(null);
    toIngest.push(parsed.event);
  }

  if (toIngest.length === 0) {
    return {
      contractVersion: 1,
      results: slots.filter((slot): slot is IngestEventResult => slot !== null),
      accepted: 0,
      duplicates: 0,
    };
  }

  const batchResult = await ingestCmsUsageBatchFromContract({ events: toIngest });
  let batchIdx = 0;
  const results = slots.map((slot) => {
    if (slot) return slot;
    return batchResult.results[batchIdx++]!;
  });

  return {
    contractVersion: 1,
    results,
    accepted: batchResult.accepted,
    duplicates: batchResult.duplicates,
  };
}

async function resolveCmsSiteBusiness(siteId: string): Promise<string | null> {
  if (!siteId || siteId.length > 100) return null;
  return withoutTenantScope("cms-billing-site-map", async () => {
    const { rows } = await query<{ business_id: string }>(
      `SELECT business_id FROM eshobe_cms_connections WHERE site_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [siteId],
    );
    return rows[0]?.business_id ?? null;
  });
}

// ---------------------------------------------------------------------------
// Entitlement projection — monotonic version per site
// ---------------------------------------------------------------------------

export interface EntitlementProjection {
  siteId: string;
  businessId: string;
  version: number;
  serving: boolean;
  planKey: string;
  features: string[];
  limits: Record<string, number | null>;
  billingCycle: { start: string | null; end: string | null };
  syncedAt: string;
}

export async function publishEntitlementProjection(input: {
  siteId: string;
  businessId: string;
  serving: boolean;
  planKey: string;
  features: string[];
  limits: Record<string, number | null>;
  periodStart: string | null;
  periodEnd: string | null;
}): Promise<number> {
  const payload = {
    siteId: input.siteId,
    serving: input.serving,
    plan: input.planKey,
    features: input.features,
    limits: input.limits,
    billingCycle: { start: input.periodStart, end: input.periodEnd },
  };
  const { rows } = await query<{ version: string }>(
    `INSERT INTO cms_entitlement_projections (site_id, business_id, version, payload)
     VALUES ($1, $2, 1, $3::jsonb)
     ON CONFLICT (site_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           business_id = EXCLUDED.business_id,
           version = cms_entitlement_projections.version + 1,
           synced_at = now()
     RETURNING version`,
    [input.siteId, input.businessId, JSON.stringify(payload)],
  );
  return Number(rows[0]?.version ?? 0);
}

/**
 * Apply a projection only when its version is strictly newer. An older
 * payload is refused and the stored version is left untouched.
 */
export async function applyEntitlementProjection(input: {
  siteId: string;
  businessId: string;
  version: number;
  payload: Record<string, unknown>;
}): Promise<{ applied: boolean; version: number }> {
  const { rows } = await query<{ version: string }>(
    `INSERT INTO cms_entitlement_projections (site_id, business_id, version, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (site_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           business_id = EXCLUDED.business_id,
           version = EXCLUDED.version,
           synced_at = now()
      WHERE cms_entitlement_projections.version < EXCLUDED.version
     RETURNING version`,
    [input.siteId, input.businessId, input.version, JSON.stringify(input.payload)],
  );
  if (!rows[0]) {
    const current = await query<{ version: string }>(
      `SELECT version FROM cms_entitlement_projections WHERE site_id = $1`,
      [input.siteId],
    );
    return { applied: false, version: Number(current.rows[0]?.version ?? 0) };
  }
  return { applied: true, version: Number(rows[0].version) };
}

export async function readEntitlementProjection(siteId: string): Promise<EntitlementProjection | null> {
  const { rows } = await query<{
    site_id: string;
    business_id: string;
    version: string;
    payload: EntitlementProjection;
    synced_at: Date;
  }>(`SELECT site_id, business_id, version, payload, synced_at FROM cms_entitlement_projections WHERE site_id = $1`, [
    siteId,
  ]);
  const row = rows[0];
  if (!row) return null;
  const payload = row.payload;
  return {
    siteId: row.site_id,
    businessId: row.business_id,
    version: Number(row.version),
    serving: Boolean(payload.serving),
    planKey: payload.planKey ?? (payload as { plan?: string }).plan ?? "",
    features: payload.features ?? [],
    limits: payload.limits ?? {},
    billingCycle: payload.billingCycle ?? { start: null, end: null },
    syncedAt: row.synced_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Spend + vendor cost + customer usage
// ---------------------------------------------------------------------------

export interface BusinessSpendPolicyRecord {
  businessId: string;
  businessName?: string;
  monthlyBudgetRial: number | null;
  thresholds: number[];
  actionAtLimit: SpendLimitAction;
  lastWarningThreshold: number | null;
  lastWarningAt: string | null;
  throttledAt: string | null;
}

export async function getSpendPolicy(businessId: string): Promise<BusinessSpendPolicyRecord | null> {
  const { rows } = await query<{
    business_id: string;
    monthly_budget_rial: string | null;
    thresholds: number[];
    action_at_limit: SpendLimitAction;
    last_warning_threshold: number | null;
    last_warning_at: Date | string | null;
    throttled_at: Date | string | null;
  }>(
    `SELECT business_id, monthly_budget_rial, thresholds, action_at_limit,
            last_warning_threshold, last_warning_at, throttled_at
       FROM business_spend_policies WHERE business_id = $1`,
    [businessId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    businessId: row.business_id,
    monthlyBudgetRial: row.monthly_budget_rial == null ? null : Number(row.monthly_budget_rial),
    thresholds: row.thresholds ?? [50, 75, 90, 100],
    actionAtLimit: row.action_at_limit,
    lastWarningThreshold: row.last_warning_threshold ?? null,
    lastWarningAt: row.last_warning_at
      ? row.last_warning_at instanceof Date
        ? row.last_warning_at.toISOString()
        : new Date(row.last_warning_at).toISOString()
      : null,
    throttledAt: row.throttled_at
      ? row.throttled_at instanceof Date
        ? row.throttled_at.toISOString()
        : new Date(row.throttled_at).toISOString()
      : null,
  };
}

export async function listSpendPolicies(): Promise<
  Array<BusinessSpendPolicyRecord & { spentRial: number; evaluation: SpendEvaluation }>
> {
  const { rows } = await query<{
    business_id: string;
    business_name: string;
    monthly_budget_rial: string | null;
    thresholds: number[];
    action_at_limit: SpendLimitAction;
    last_warning_threshold: number | null;
    last_warning_at: Date | string | null;
    throttled_at: Date | string | null;
  }>(
    `SELECT p.business_id, b.name AS business_name, p.monthly_budget_rial, p.thresholds,
            p.action_at_limit, p.last_warning_threshold, p.last_warning_at, p.throttled_at
       FROM business_spend_policies p
       JOIN businesses b ON b.id = p.business_id
      ORDER BY p.updated_at DESC`,
  );
  const results: Array<BusinessSpendPolicyRecord & { spentRial: number; evaluation: SpendEvaluation }> = [];
  for (const row of rows) {
    const spentRial = await monthSpendRial(row.business_id);
    const policy: BusinessSpendPolicyRecord = {
      businessId: row.business_id,
      businessName: row.business_name,
      monthlyBudgetRial: row.monthly_budget_rial == null ? null : Number(row.monthly_budget_rial),
      thresholds: row.thresholds ?? [50, 75, 90, 100],
      actionAtLimit: row.action_at_limit,
      lastWarningThreshold: row.last_warning_threshold ?? null,
      lastWarningAt: row.last_warning_at
        ? row.last_warning_at instanceof Date
          ? row.last_warning_at.toISOString()
          : new Date(row.last_warning_at).toISOString()
        : null,
      throttledAt: row.throttled_at
        ? row.throttled_at instanceof Date
          ? row.throttled_at.toISOString()
          : new Date(row.throttled_at).toISOString()
        : null,
    };
    const evaluation = evaluateSpend({
      spentRial,
      budgetRial: policy.monthlyBudgetRial,
      thresholds: policy.thresholds,
      action: policy.actionAtLimit,
      critical: false,
    });
    results.push({ ...policy, spentRial, evaluation });
  }
  return results;
}

export async function saveSpendPolicy(input: {
  businessId: string;
  monthlyBudgetRial: number | null;
  thresholds?: number[];
  actionAtLimit: SpendLimitAction;
}): Promise<void> {
  const thresholds = input.thresholds ?? [50, 75, 90, 100];
  await query(
    `INSERT INTO business_spend_policies (business_id, monthly_budget_rial, thresholds, action_at_limit)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id) DO UPDATE
       SET monthly_budget_rial = EXCLUDED.monthly_budget_rial,
           thresholds = EXCLUDED.thresholds,
           action_at_limit = EXCLUDED.action_at_limit,
           throttled_at = CASE
             WHEN EXCLUDED.action_at_limit = 'throttle_noncritical' THEN business_spend_policies.throttled_at
             ELSE NULL
           END,
           updated_at = now()`,
    [input.businessId, input.monthlyBudgetRial, thresholds, input.actionAtLimit],
  );
  billingLog("billing.spend.policy", { businessId: input.businessId, action: input.actionAtLimit });
}

export interface MonthlySpendBreakdown {
  periodMonth: string;
  walletUsageDebitsRial: number;
  spendRefundsRial: number;
  activeReservationsRial: number;
  allowanceUsedRial: number;
  aiDebtIncurredRial: number;
  externalRatedUsageRial: number;
  totalSpendRial: number;
}

export async function computeBusinessMonthlySpend(
  businessId: string,
  now: Date = new Date(),
): Promise<MonthlySpendBreakdown> {
  const window = tehranMonthWindow(now);
  const startIso = window.startUtc.toISOString();
  const nextStartIso = window.nextStartUtc.toISOString();

  const { rows } = await query<{
    wallet_debits_rial: string;
    spend_refunds_rial: string;
    active_reservations_rial: string;
    allowance_used_rial: string;
    ai_debt_incurred_rial: string;
    external_rated_rial: string;
  }>(
    `SELECT
       COALESCE((
         SELECT SUM(amount_rial)
           FROM wallet_ledger
          WHERE business_id = $1
            AND direction = 'debit'
            AND kind <> 'admin_adjust'
            AND COALESCE(metadata->>'phase', '') <> 'reserved'
            AND COALESCE((metadata->>'aiDebtPaydown')::boolean, false) = false
            AND created_at >= $2::timestamptz
            AND created_at < $3::timestamptz
       ), 0)::text AS wallet_debits_rial,
       COALESCE((
         SELECT SUM(amount_rial)
           FROM wallet_ledger
          WHERE business_id = $1
            AND direction = 'credit'
            AND kind = 'refund'
            AND COALESCE((metadata->>'reversesSpend')::boolean, true) = true
            AND created_at >= $2::timestamptz
            AND created_at < $3::timestamptz
       ), 0)::text AS spend_refunds_rial,
       COALESCE((
         SELECT SUM(amount_rial)
           FROM wallet_ledger
          WHERE business_id = $1
            AND direction = 'debit'
            AND COALESCE(metadata->>'phase', '') = 'reserved'
            AND created_at >= $2::timestamptz
            AND created_at < $3::timestamptz
       ), 0)::text AS active_reservations_rial,
       COALESCE((
         SELECT SUM(used_rial)
           FROM ai_plan_allowance_usage
          WHERE business_id = $1
            AND period_month = $4
       ), 0)::text AS allowance_used_rial,
       GREATEST(
         COALESCE((
           SELECT SUM(debt_rial)
             FROM ai_wallet_settlements
            WHERE business_id = $1
              AND created_at >= $2::timestamptz
              AND created_at < $3::timestamptz
         ), 0),
         COALESCE((
           SELECT debt_rial
             FROM ai_wallet_debt
            WHERE business_id = $1
              AND updated_at >= $2::timestamptz
              AND updated_at < $3::timestamptz
         ), 0)
       )::text AS ai_debt_incurred_rial,
       COALESCE((
         SELECT SUM(r.rated_amount_rial)
           FROM billing_usage_ratings r
           JOIN billing_usage_events e ON e.id = r.usage_event_id
          WHERE r.business_id = $1
            AND e.occurred_at >= $2::timestamptz
            AND e.occurred_at < $3::timestamptz
            AND e.source NOT IN ('ai_wallet_settlement', 'media_billing', 'message_outbox')
       ), 0)::text AS external_rated_rial`,
    [businessId, startIso, nextStartIso, window.periodMonth],
  );

  const row = rows[0];
  const walletUsageDebitsRial = Number(row?.wallet_debits_rial ?? 0);
  const spendRefundsRial = Number(row?.spend_refunds_rial ?? 0);
  const activeReservationsRial = Number(row?.active_reservations_rial ?? 0);
  const allowanceUsedRial = Number(row?.allowance_used_rial ?? 0);
  const aiDebtIncurredRial = Number(row?.ai_debt_incurred_rial ?? 0);
  const externalRatedUsageRial = Number(row?.external_rated_rial ?? 0);
  const totalSpendRial = Math.max(
    0,
    walletUsageDebitsRial -
      spendRefundsRial +
      activeReservationsRial +
      allowanceUsedRial +
      aiDebtIncurredRial +
      externalRatedUsageRial,
  );

  return {
    periodMonth: window.periodMonth,
    walletUsageDebitsRial,
    spendRefundsRial,
    activeReservationsRial,
    allowanceUsedRial,
    aiDebtIncurredRial,
    externalRatedUsageRial,
    totalSpendRial,
  };
}

export async function monthSpendRial(businessId: string, now: Date = new Date()): Promise<number> {
  const breakdown = await computeBusinessMonthlySpend(businessId, now);
  return breakdown.totalSpendRial;
}

export async function evaluateBusinessSpend(
  businessId: string,
  opts?: { now?: Date; critical?: boolean },
): Promise<{
  policy: BusinessSpendPolicyRecord | null;
  breakdown: MonthlySpendBreakdown;
  evaluation: SpendEvaluation;
  warningEmitted: boolean;
}> {
  const now = opts?.now ?? new Date();
  const critical = opts?.critical ?? false;
  const [policy, breakdown] = await Promise.all([
    getSpendPolicy(businessId),
    computeBusinessMonthlySpend(businessId, now),
  ]);
  if (!policy) {
    return {
      policy: null,
      breakdown,
      evaluation: {
        percent: null,
        crossedThresholds: [],
        warned: false,
        atLimit: false,
        blocked: false,
        throttled: false,
      },
      warningEmitted: false,
    };
  }

  const evaluation = evaluateSpend({
    spentRial: breakdown.totalSpendRial,
    budgetRial: policy.monthlyBudgetRial,
    thresholds: policy.thresholds,
    action: policy.actionAtLimit,
    critical,
  });

  let warningEmitted = false;
  if (evaluation.warned && evaluation.crossedThresholds.length > 0) {
    const highestCrossed = Math.max(...evaluation.crossedThresholds);
    const prevThreshold = policy.lastWarningThreshold ?? 0;
    if (highestCrossed > prevThreshold) {
      warningEmitted = true;
      await query(
        `UPDATE business_spend_policies
            SET last_warning_threshold = $2,
                last_warning_at = now(),
                throttled_at = CASE WHEN $3 THEN COALESCE(throttled_at, now()) ELSE throttled_at END,
                updated_at = now()
          WHERE business_id = $1`,
        [businessId, highestCrossed, evaluation.throttled],
      );
      billingLog("billing.spend.warning", {
        businessId,
        spentRial: breakdown.totalSpendRial,
        budgetRial: policy.monthlyBudgetRial,
        highestCrossed,
        action: policy.actionAtLimit,
      });
    } else if (evaluation.throttled && !policy.throttledAt) {
      await query(
        `UPDATE business_spend_policies
            SET throttled_at = COALESCE(throttled_at, now()),
                updated_at = now()
          WHERE business_id = $1`,
        [businessId],
      );
      billingLog("billing.spend.throttled", {
        businessId,
        spentRial: breakdown.totalSpendRial,
        budgetRial: policy.monthlyBudgetRial,
      });
    }
  } else if (evaluation.throttled && !policy.throttledAt) {
    await query(
      `UPDATE business_spend_policies
          SET throttled_at = COALESCE(throttled_at, now()),
              updated_at = now()
        WHERE business_id = $1`,
      [businessId],
    );
    billingLog("billing.spend.throttled", {
      businessId,
      spentRial: breakdown.totalSpendRial,
      budgetRial: policy.monthlyBudgetRial,
    });
  }

  return {
    policy,
    breakdown,
    evaluation,
    warningEmitted,
  };
}

export async function recordVendorCost(input: {
  businessId: string;
  meterKey?: string | null;
  provider: string;
  sourceReference: string;
  amountRial: number;
  currency?: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ inserted: boolean }> {
  const amount = Math.floor(input.amountRial);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("bad_amount");
  const { rows } = await query<{ id: string }>(
    `INSERT INTO billing_vendor_cost_events
       (business_id, meter_key, provider, source_reference, currency, amount_rial, occurred_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()), $8::jsonb)
     ON CONFLICT (provider, source_reference) DO NOTHING
     RETURNING id`,
    [
      input.businessId,
      input.meterKey ?? null,
      input.provider,
      input.sourceReference,
      input.currency ?? "IRR",
      amount,
      input.occurredAt ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return { inserted: Boolean(rows[0]) };
}

export interface CustomerMeterUsage {
  meterKey: string;
  name: string;
  unit: string;
  used: number;
  included: number | null;
  overage: number;
  estimatedRial: number;
  customerVisible: boolean;
}

export async function customerUsageSummary(businessId: string): Promise<{
  planKey: string | null;
  periodEnd: string | null;
  walletBalanceRial: number;
  spend: {
    budgetRial: number | null;
    spentRial: number;
    action: string | null;
    crossedThresholds?: number[];
    blocked?: boolean;
    throttled?: boolean;
  };
  meters: CustomerMeterUsage[];
}> {
  const window = tehranMonthWindow(new Date());
  const { rows } = await query<{
    meter_key: string;
    name: string;
    unit: string;
    customer_visible: boolean;
    used: string;
    included: string | null;
    rated: string;
    plan_key: string | null;
    period_end: Date | null;
    balance: string | null;
  }>(
    `SELECT m.key AS meter_key, m.name, m.unit, m.customer_visible,
            COALESCE(r.quantity, 0)::text AS used,
            a.included_quantity::text AS included,
            COALESCE(rt.rated, 0)::text AS rated,
            b.plan AS plan_key,
            s.current_period_end AS period_end,
            w.balance_rial::text AS balance
       FROM billing_meters m
       JOIN businesses b ON b.id = $1
       LEFT JOIN business_subscriptions s ON s.business_id = b.id
       LEFT JOIN business_wallets w ON w.business_id = b.id
       LEFT JOIN billing_plan_meter_allowances a
              ON a.plan_key = b.plan AND a.meter_key = m.key
       LEFT JOIN LATERAL (
         SELECT SUM(quantity) AS quantity
           FROM billing_usage_rollups_daily d
          WHERE d.business_id = b.id AND d.meter_key = m.key
            AND d.day >= $2::date
       ) r ON true
       LEFT JOIN LATERAL (
         SELECT SUM(ur.rated_amount_rial) AS rated
           FROM billing_usage_ratings ur
           JOIN billing_usage_events e ON e.id = ur.usage_event_id
          WHERE ur.business_id = b.id AND e.meter_key = m.key
            AND e.occurred_at >= $3::timestamptz
            AND e.occurred_at < $4::timestamptz
       ) rt ON true
      WHERE m.active AND m.customer_visible
      ORDER BY m.key`,
    [
      businessId,
      `${window.periodMonth}-01`,
      window.startUtc.toISOString(),
      window.nextStartUtc.toISOString(),
    ],
  );
  const spendEval = await evaluateBusinessSpend(businessId);
  const first = rows[0];
  return {
    planKey: first?.plan_key ?? null,
    periodEnd: first?.period_end ? new Date(first.period_end).toISOString() : null,
    walletBalanceRial: Number(first?.balance ?? 0),
    spend: {
      budgetRial: spendEval.policy?.monthlyBudgetRial ?? null,
      spentRial: spendEval.breakdown.totalSpendRial,
      action: spendEval.policy?.actionAtLimit ?? null,
      crossedThresholds: spendEval.evaluation.crossedThresholds,
      blocked: spendEval.evaluation.blocked,
      throttled: spendEval.evaluation.throttled,
    },
    meters: rows.map((row) => {
      const used = Number(row.used);
      const included = row.included == null ? null : Number(row.included);
      return {
        meterKey: row.meter_key,
        name: row.name,
        unit: row.unit,
        used,
        included,
        overage: included == null ? 0 : Math.max(0, used - included),
        estimatedRial: Number(row.rated),
        customerVisible: row.customer_visible,
      };
    }),
  };
}

export async function readCommercialSettings(): Promise<Record<string, unknown>> {
  const { rows } = await query<Record<string, unknown>>(`SELECT * FROM billing_commercial_settings WHERE id`);
  return rows[0] ?? {};
}

export async function saveCommercialSettings(patch: {
  invoicePrefix?: string;
  defaultDueDays?: number;
  defaultGraceDays?: number;
  rounding?: "ceil" | "floor";
  minimumTopUpRial?: number;
  overagePolicy?: "charge" | "block";
  prorationPolicy?: "none" | "daily";
  defaultSpendAction?: string;
  invoiceFooter?: string;
  taxRateBps?: number;
}): Promise<void> {
  await query(
    `UPDATE billing_commercial_settings SET
       invoice_prefix = COALESCE($1, invoice_prefix),
       default_due_days = COALESCE($2, default_due_days),
       default_grace_days = COALESCE($3, default_grace_days),
       rounding = COALESCE($4, rounding),
       minimum_top_up_rial = COALESCE($5, minimum_top_up_rial),
       overage_policy = COALESCE($6, overage_policy),
       proration_policy = COALESCE($7, proration_policy),
       default_spend_action = COALESCE($8, default_spend_action),
       invoice_footer = COALESCE($9, invoice_footer),
       tax_rate_bps = COALESCE($10, tax_rate_bps),
       updated_at = now()
     WHERE id`,
    [
      patch.invoicePrefix ?? null,
      patch.defaultDueDays ?? null,
      patch.defaultGraceDays ?? null,
      patch.rounding ?? null,
      patch.minimumTopUpRial ?? null,
      patch.overagePolicy ?? null,
      patch.prorationPolicy ?? null,
      patch.defaultSpendAction ?? null,
      patch.invoiceFooter ?? null,
      patch.taxRateBps ?? null,
    ],
  );
}

export async function previewCommercialQuote(input: {
  kind: "plan_subscription" | "custom_top_up" | "package_top_up" | "addon_purchase" | "meter_usage";
  businessId?: string | null;
  planKey?: string | null;
  billingCycle?: "monthly" | "yearly";
  packageId?: string | null;
  featureKey?: string | null;
  meterKey?: string | null;
  amountRial?: number | null;
  quantity?: number | null;
  includeRecurringAddons?: boolean;
}): Promise<
  Omit<CommercialQuoteResult, "kind"> & {
    kind: string;
    minimumTopUpRial: number;
    belowMinimumTopUp: boolean;
    creditGrantedRial?: number;
  }
> {
  const settings = await readCommercialSettings();
  const taxRateBps = Number(settings.tax_rate_bps ?? 0);
  const rounding: "ceil" | "floor" = settings.rounding === "floor" ? "floor" : "ceil";
  const minimumTopUpRial = Number(settings.minimum_top_up_rial ?? 0);
  const nowIso = new Date().toISOString();

  if (input.kind === "plan_subscription") {
    let basePlanRial = 0;
    const addons: CommercialQuoteAddonLine[] = [];
    if (input.planKey) {
      const { rows } = await query<{
        key: string;
        name: string;
        monthly_price_rial: string | null;
      }>(
        `SELECT key, name, monthly_price_rial
           FROM billing_plans WHERE key = $1`,
        [input.planKey],
      );
      const plan = rows[0];
      if (plan) {
        basePlanRial = Number(plan.monthly_price_rial ?? 0);
      }
      if (input.includeRecurringAddons !== false) {
        const { rows: addonRows } = await query<{
          feature_key: string;
          feature_name: string | null;
          price_rial: string;
        }>(
          `SELECT pf.feature_key, f.name AS feature_name, pf.price_rial
             FROM billing_plan_features pf
             LEFT JOIN feature_flags f ON f.key = pf.feature_key
            WHERE pf.plan_key = $1
              AND pf.pricing_model = 'monthly'
              AND pf.price_rial > 0
            ORDER BY pf.sort_order, pf.feature_key`,
          [input.planKey],
        );
        for (const addon of addonRows) {
          addons.push({
            featureKey: addon.feature_key,
            description: addon.feature_name ?? addon.feature_key,
            amountRial: Number(addon.price_rial),
          });
        }
      }
    }
    const quote = calculateCommercialQuote({
      kind: "plan",
      basePlanRial,
      addons,
      taxRateBps,
      rounding,
    });
    return {
      ...quote,
      kind: input.kind,
      minimumTopUpRial,
      belowMinimumTopUp: false,
    };
  }

  if (input.kind === "custom_top_up") {
    const amount = Math.max(0, Math.floor(input.amountRial ?? 0));
    const quote = calculateCommercialQuote({
      kind: "topup",
      amountRial: amount,
      creditRial: amount,
      minimumTopUpRial,
      isPackage: false,
      taxRateBps,
      rounding,
    });
    return {
      ...quote,
      kind: input.kind,
      minimumTopUpRial,
      belowMinimumTopUp: quote.error === "below_minimum_top_up",
      creditGrantedRial: amount,
    };
  }

  if (input.kind === "package_top_up" && input.packageId) {
    const { rows } = await query<{
      name: string;
      price_rial: string;
      credit_rial: string;
    }>(
      `SELECT name, price_rial, credit_rial FROM credit_packages WHERE id = $1`,
      [input.packageId],
    );
    const pkg = rows[0];
    const price = pkg ? Number(pkg.price_rial) : 0;
    const credit = pkg ? Number(pkg.credit_rial) : 0;
    const quote = calculateCommercialQuote({
      kind: "topup",
      amountRial: price,
      creditRial: credit,
      minimumTopUpRial,
      isPackage: true,
      taxRateBps,
      rounding,
    });
    return {
      ...quote,
      kind: input.kind,
      minimumTopUpRial,
      belowMinimumTopUp: false,
      creditGrantedRial: credit,
    };
  }

  if (input.kind === "addon_purchase" && input.featureKey) {
    const { rows } = await query<{
      price_rial: string;
    }>(
      `SELECT price_rial FROM billing_plan_features
        WHERE feature_key = $1 AND pricing_model = 'addon'
        ORDER BY price_rial DESC LIMIT 1`,
      [input.featureKey],
    );
    const price = rows[0] ? Number(rows[0].price_rial) : Math.max(0, Math.floor(input.amountRial ?? 0));
    const quote = calculateCommercialQuote({
      kind: "addon",
      amountRial: price,
      taxRateBps,
      rounding,
    });
    return {
      ...quote,
      kind: input.kind,
      minimumTopUpRial,
      belowMinimumTopUp: false,
    };
  }

  // meter_usage
  const qty = Math.max(0, Math.floor(input.quantity ?? 0));
  const pv = input.meterKey ? await priceAt("meter", input.meterKey, nowIso) : null;
  const quote = calculateCommercialQuote({
    kind: "meter",
    quantity: qty,
    price: pv ? { unitAmountRial: pv.unitAmountRial, unitSize: pv.unitSize } : null,
    taxRateBps,
    rounding,
  });
  return {
    ...quote,
    kind: input.kind,
    minimumTopUpRial,
    belowMinimumTopUp: false,
  };
}
