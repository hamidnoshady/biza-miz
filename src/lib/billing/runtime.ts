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
import { selectPriceVersion, type PriceVersionPoint } from "./rating/engine";
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
    if (input.ratedAmountRial != null) {
      await db.query(
        `INSERT INTO billing_usage_ratings
           (usage_event_id, business_id, price_version_id, rated_amount_rial, allowance_quantity, overage_quantity)
         VALUES ($1,$2,$3,$4,0,$5)
         ON CONFLICT (usage_event_id) DO NOTHING`,
        [rows[0].id, input.businessId, input.priceVersionId ?? null, input.ratedAmountRial, input.quantity],
      );
    }
    await refreshDailyRollup(db, input.businessId, input.meterKey, input.occurredAt ?? new Date().toISOString());
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

export async function listEffectivePrices(targetType: string, targetKey: string): Promise<StoredPriceVersion[]> {
  const { rows } = await query<{
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

export async function getSpendPolicy(businessId: string): Promise<{
  monthlyBudgetRial: number | null;
  thresholds: number[];
  actionAtLimit: "continue" | "warn_only" | "block_noncritical" | "throttle_noncritical";
} | null> {
  const { rows } = await query<{
    monthly_budget_rial: string | null;
    thresholds: number[];
    action_at_limit: "continue" | "warn_only" | "block_noncritical" | "throttle_noncritical";
  }>(
    `SELECT monthly_budget_rial, thresholds, action_at_limit
       FROM business_spend_policies WHERE business_id = $1`,
    [businessId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    monthlyBudgetRial: row.monthly_budget_rial == null ? null : Number(row.monthly_budget_rial),
    thresholds: row.thresholds ?? [50, 75, 90, 100],
    actionAtLimit: row.action_at_limit,
  };
}

export async function saveSpendPolicy(input: {
  businessId: string;
  monthlyBudgetRial: number | null;
  thresholds?: number[];
  actionAtLimit: "continue" | "warn_only" | "block_noncritical" | "throttle_noncritical";
}): Promise<void> {
  const thresholds = input.thresholds ?? [50, 75, 90, 100];
  await query(
    `INSERT INTO business_spend_policies (business_id, monthly_budget_rial, thresholds, action_at_limit)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id) DO UPDATE
       SET monthly_budget_rial = EXCLUDED.monthly_budget_rial,
           thresholds = EXCLUDED.thresholds,
           action_at_limit = EXCLUDED.action_at_limit,
           updated_at = now()`,
    [input.businessId, input.monthlyBudgetRial, thresholds, input.actionAtLimit],
  );
  billingLog("billing.spend.policy", { businessId: input.businessId, action: input.actionAtLimit });
}

export async function monthSpendRial(businessId: string, now: Date = new Date()): Promise<number> {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const { rows } = await query<{ spent: string }>(
    `SELECT COALESCE(SUM(rated_amount_rial), 0)::text AS spent
       FROM billing_usage_ratings r
       JOIN billing_usage_events e ON e.id = r.usage_event_id
      WHERE r.business_id = $1 AND e.occurred_at >= $2::date`,
    [businessId, month],
  );
  return Number(rows[0]?.spent ?? 0);
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
  spend: { budgetRial: number | null; spentRial: number; action: string | null };
  meters: CustomerMeterUsage[];
}> {
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
            AND d.day >= date_trunc('month', now())::date
       ) r ON true
       LEFT JOIN LATERAL (
         SELECT SUM(ur.rated_amount_rial) AS rated
           FROM billing_usage_ratings ur
           JOIN billing_usage_events e ON e.id = ur.usage_event_id
          WHERE ur.business_id = b.id AND e.meter_key = m.key
            AND e.occurred_at >= date_trunc('month', now())
       ) rt ON true
      WHERE m.active AND m.customer_visible
      ORDER BY m.key`,
    [businessId],
  );
  const policy = await getSpendPolicy(businessId);
  const spent = await monthSpendRial(businessId);
  const first = rows[0];
  return {
    planKey: first?.plan_key ?? null,
    periodEnd: first?.period_end ? new Date(first.period_end).toISOString() : null,
    walletBalanceRial: Number(first?.balance ?? 0),
    spend: {
      budgetRial: policy?.monthlyBudgetRial ?? null,
      spentRial: spent,
      action: policy?.actionAtLimit ?? null,
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
