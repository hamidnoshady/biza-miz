/**
 * Issue #902 §4 — the persistence and wiring around `retail-pricing.ts`.
 *
 * The pure module decides what a message costs; this one decides *which policy
 * is in force*, publishes new policies, and posts the two halves of the money:
 *
 *   * retail  → the business's ONE wallet (`reserveMessageSend` /
 *               `settleMessageSend`, already idempotent);
 *   * wholesale → `billing_vendor_cost_events`, flagged `tenant_visible=false`
 *               so supplier cost can never reach a tenant view (§0, DoD #3).
 *
 * A reservation records the *version number* it priced with, so a publish that
 * lands mid-campaign cannot retroactively re-price a message that was already
 * reserved, and settlement never re-quotes.
 */
import { query, withoutTenantScope, withoutTenantScopeTransaction } from "../db";
import { recordVendorCost } from "../billing/runtime";
import {
  DEFAULT_RETAIL_PRICE_VERSION,
  parseRetailPriceVersionInput,
  quoteRetailBatch,
  remainingFreeAllowance,
  type RetailChannel,
  type RetailChargeQuote,
  type RetailPriceOverride,
  type RetailPriceSlab,
  type RetailPriceVersion,
  type RetailPriceVersionInput,
} from "./retail-pricing";

/** The scope name used for every retail-pricing read and write. */
const SCOPE = "kavenegar-retail-pricing";

type VersionRow = {
  id: string;
  version: number;
  effective_from: string | Date;
  effective_until: string | Date | null;
  markup_bps: number;
  fixed_surcharge_rial: string | number;
  discount_bps: number;
  discount_until: string | Date | null;
  tax_bps: number;
  free_allowance_segments: number;
  failed_send_policy: string;
  note: string | null;
  created_by: string | null;
  created_at: string | Date;
};

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function int(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

async function loadSlabs(versionId: string): Promise<RetailPriceSlab[]> {
  const { rows } = await query<{
    min_monthly_segments: string | number;
    markup_bps: number;
    fixed_surcharge_rial: string | number;
  }>(
    `SELECT min_monthly_segments, markup_bps, fixed_surcharge_rial
       FROM kavenegar_retail_price_slabs
      WHERE version_id = $1
      ORDER BY min_monthly_segments`,
    [versionId],
  );
  return rows.map((row) => ({
    minMonthlySegments: int(row.min_monthly_segments),
    markupBps: int(row.markup_bps),
    fixedSurchargeRial: int(row.fixed_surcharge_rial),
  }));
}

async function loadOverrides(versionId: string): Promise<RetailPriceOverride[]> {
  const { rows } = await query<{
    scope: string;
    scope_business_id: string | null;
    channel: string | null;
    markup_bps: number | null;
    fixed_surcharge_rial: string | number | null;
    note: string | null;
  }>(
    `SELECT scope, scope_business_id, channel, markup_bps, fixed_surcharge_rial, note
       FROM kavenegar_retail_price_overrides
      WHERE version_id = $1
      ORDER BY scope, coalesce(channel, ''), coalesce(scope_business_id::text, '')`,
    [versionId],
  );
  return rows.map((row) => ({
    scope: row.scope as RetailPriceOverride["scope"],
    businessId: row.scope_business_id,
    channel: (row.channel as RetailChannel | null) ?? null,
    markupBps: row.markup_bps === null ? null : int(row.markup_bps),
    fixedSurchargeRial: row.fixed_surcharge_rial === null ? null : int(row.fixed_surcharge_rial),
    note: row.note,
  }));
}

function toVersion(row: VersionRow, slabs: RetailPriceSlab[], overrides: RetailPriceOverride[]): RetailPriceVersion {
  return {
    id: row.id,
    version: int(row.version),
    effectiveFrom: iso(row.effective_from),
    effectiveUntil: iso(row.effective_until),
    markupBps: int(row.markup_bps),
    fixedSurchargeRial: int(row.fixed_surcharge_rial),
    discountBps: int(row.discount_bps),
    discountUntil: iso(row.discount_until),
    taxBps: int(row.tax_bps),
    freeAllowanceSegments: int(row.free_allowance_segments),
    failedSendPolicy: row.failed_send_policy === "charge" ? "charge" : "refund",
    note: row.note,
    createdBy: row.created_by,
    slabs,
    overrides,
  };
}

/**
 * The policy in force at `at`. No published version (the state every business
 * is in until Superadmin publishes one) returns the built-in default, i.e. the
 * Billing base rate unchanged.
 */
export async function loadRetailPriceVersionAt(at: Date = new Date()): Promise<RetailPriceVersion> {
  return withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<VersionRow>(
      `SELECT * FROM kavenegar_retail_price_versions
        WHERE effective_from <= $1
          AND (effective_until IS NULL OR effective_until > $1)
        ORDER BY effective_from DESC
        LIMIT 1`,
      [at.toISOString()],
    );
    const row = rows[0];
    if (!row) return DEFAULT_RETAIL_PRICE_VERSION;
    const [slabs, overrides] = await Promise.all([loadSlabs(row.id), loadOverrides(row.id)]);
    return toVersion(row, slabs, overrides);
  });
}

export async function listRetailPriceVersions(limit = 20): Promise<RetailPriceVersion[]> {
  return withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<VersionRow>(
      `SELECT * FROM kavenegar_retail_price_versions
        ORDER BY effective_from DESC, version DESC
        LIMIT $1`,
      [Math.min(100, Math.max(1, Math.trunc(limit)))],
    );
    return Promise.all(
      rows.map(async (row) => toVersion(row, await loadSlabs(row.id), await loadOverrides(row.id))),
    );
  });
}

export type PublishRetailPriceVersionResult =
  | { ok: true; version: RetailPriceVersion }
  | { ok: false; error: string };

/**
 * Publish a new price policy.
 *
 * The previous open version is closed at the new version's `effective_from`
 * rather than at `now()`: scheduling a price for tomorrow must not create a
 * gap today. Both statements — the close and the insert — run in one
 * transaction, and the partial unique index on "one open version" makes a
 * concurrent double-publish fail loudly instead of silently forking the price.
 */
export async function publishRetailPriceVersion(input: {
  body: unknown;
  createdBy?: string | null;
}): Promise<PublishRetailPriceVersionResult> {
  const parsed = parseRetailPriceVersionInput(input.body);
  if (!parsed.ok) return parsed;
  const value: RetailPriceVersionInput = parsed.value;
  const effectiveFrom = value.effectiveFrom ?? new Date().toISOString();

  return withoutTenantScopeTransaction(SCOPE, async () => {
    // Close the version in force at the new one's start. A future-dated publish
    // therefore keeps today's price valid until the boundary and leaves a gap
    // of nothing: `effective_until` is exclusive, `effective_from` inclusive.
    const open = await query<{ id: string; effective_from: string | Date }>(
      `SELECT id, effective_from FROM kavenegar_retail_price_versions WHERE effective_until IS NULL`,
    );
    const current = open.rows[0];
    if (current && Date.parse(effectiveFrom) <= Date.parse(iso(current.effective_from) ?? "")) {
      // Back-dating behind a version that is already in force would rewrite the
      // price of messages already reserved under it.
      return { ok: false as const, error: "effective_from_before_current" };
    }
    if (current) {
      await query(
        `UPDATE kavenegar_retail_price_versions SET effective_until = $1 WHERE id = $2`,
        [effectiveFrom, current.id],
      );
    }
    const { rows } = await query<VersionRow>(
      `INSERT INTO kavenegar_retail_price_versions
         (version, effective_from, markup_bps, fixed_surcharge_rial, discount_bps,
          discount_until, tax_bps, free_allowance_segments, failed_send_policy, note, created_by)
       VALUES (
         COALESCE((SELECT MAX(version) + 1 FROM kavenegar_retail_price_versions), 1),
         $1::timestamptz, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        effectiveFrom,
        value.markupBps,
        value.fixedSurchargeRial,
        value.discountBps,
        value.discountUntil,
        value.taxBps,
        value.freeAllowanceSegments,
        value.failedSendPolicy,
        value.note,
        input.createdBy ?? null,
      ],
    );
    const version = rows[0];
    for (const slab of value.slabs) {
      await query(
        `INSERT INTO kavenegar_retail_price_slabs
           (version_id, min_monthly_segments, markup_bps, fixed_surcharge_rial)
         VALUES ($1, $2, $3, $4)`,
        [version.id, slab.minMonthlySegments, slab.markupBps, slab.fixedSurchargeRial],
      );
    }
    for (const override of value.overrides) {
      await query(
        `INSERT INTO kavenegar_retail_price_overrides
           (version_id, scope, scope_business_id, channel, markup_bps, fixed_surcharge_rial, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          version.id,
          override.scope,
          override.businessId,
          override.channel,
          override.markupBps,
          override.fixedSurchargeRial,
          override.note ?? null,
        ],
      );
    }
    return {
      ok: true as const,
      version: toVersion(version, value.slabs, value.overrides),
    };
  });
}

/**
 * Segments this business has actually been billed for in the current UTC
 * calendar month — the input to slab selection and to the free allowance.
 *
 * Read from `billing_usage_events` (the append-only usage record the outbox
 * already writes) rather than from a counter, so a rollup rebuild cannot
 * change a price. Usage that was never recorded (a send whose usage append
 * failed) simply does not discount the tier; it never overcharges.
 */
export async function monthlyBilledSegments(businessId: string, at: Date = new Date()): Promise<number> {
  return withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<{ used: string | number | null }>(
      `SELECT coalesce(sum(quantity), 0) AS used
         FROM billing_usage_events
        WHERE business_id = $1
          AND meter_key = 'messaging.sms_segment'
          AND event_kind = 'usage'
          AND occurred_at >= date_trunc('month', $2::timestamptz)`,
      [businessId, at.toISOString()],
    );
    return int(rows[0]?.used);
  });
}

export interface BusinessSendQuote {
  version: RetailPriceVersion;
  monthlySegments: number;
  freeAllowanceRemaining: number;
  quotes: RetailChargeQuote[];
  totalRial: number;
  freeUnitsUsed: number;
}

/**
 * Quote a batch for one business. The version is resolved **once**, at
 * reservation, and travels with the batch: every message in it is priced by the
 * same policy even if a publish lands while the drain is running.
 */
export async function quoteBusinessSends(input: {
  businessId: string;
  messages: { channel: RetailChannel; unitPriceRial: number; quantity: number }[];
  at?: Date;
}): Promise<BusinessSendQuote> {
  const at = input.at ?? new Date();
  const version = await loadRetailPriceVersionAt(at);
  const monthlySegments = await monthlyBilledSegments(input.businessId, at);
  const batch = quoteRetailBatch({
    businessId: input.businessId,
    monthlySegments,
    version,
    messages: input.messages,
    at,
  });
  return {
    version,
    monthlySegments,
    freeAllowanceRemaining: remainingFreeAllowance(version, monthlySegments),
    quotes: batch.quotes,
    totalRial: batch.totalRial,
    freeUnitsUsed: batch.freeUnitsUsed,
  };
}

/**
 * Post the provider's real cost for one accepted message.
 *
 * `source_reference` is the outbox row, and `(provider, source_reference)` is
 * unique in `billing_vendor_cost_events`, so a replay of the same send — a
 * retried drain, a duplicated tick — cannot post the cost twice. The row is
 * flagged internal: supplier cost is not tenant data.
 */
export async function recordManagedMessageVendorCost(input: {
  businessId: string;
  outboxId: string;
  amountRial: number;
  segments?: number;
  providerMessageId?: string | null;
  retailRial?: number;
  priceVersion?: number;
}): Promise<{ inserted: boolean }> {
  if (!Number.isFinite(input.amountRial) || input.amountRial < 0) return { inserted: false };
  return withoutTenantScope(SCOPE, async () =>
    recordVendorCost({
      businessId: input.businessId,
      meterKey: "messaging.sms_segment",
      provider: "kavenegar",
      sourceReference: `message_outbox:${input.outboxId}`,
      amountRial: input.amountRial,
      metadata: {
        managedService: true,
        segments: input.segments ?? null,
        providerMessageId: input.providerMessageId ?? null,
        retailRial: input.retailRial ?? null,
        priceVersion: input.priceVersion ?? null,
      },
      tenantVisible: false,
    }),
  );
}

/**
 * What the console's Retail Pricing tab shows above the form: the policy in
 * force, the history, and how much of the fleet is inside a volume tier.
 */
export interface RetailPricingOverview {
  current: RetailPriceVersion;
  history: RetailPriceVersion[];
  month: { businessesWithUsage: number; segments: number };
}

export async function getRetailPricingOverview(limit = 10): Promise<RetailPricingOverview> {
  const [current, history, month] = await Promise.all([
    loadRetailPriceVersionAt(),
    listRetailPriceVersions(limit),
    withoutTenantScope(SCOPE, async () => {
      const { rows } = await query<{ businesses: string | number; segments: string | number | null }>(
        `SELECT count(DISTINCT business_id) AS businesses, coalesce(sum(quantity), 0) AS segments
           FROM billing_usage_events
          WHERE meter_key = 'messaging.sms_segment'
            AND event_kind = 'usage'
            AND occurred_at >= date_trunc('month', now())`,
      );
      return {
        businessesWithUsage: int(rows[0]?.businesses),
        segments: int(rows[0]?.segments),
      };
    }),
  ]);
  return { current, history, month };
}
