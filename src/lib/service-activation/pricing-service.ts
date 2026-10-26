/**
 * Service tariffs — the database half of the pricing model (issue #1041 §A).
 *
 * The catalogue lives in `service_price_schedules` (migration 0255) and is the
 * ONE place a per-service setup fee or enabled-hour rate is written. Every
 * write publishes a new immutable version: an existing row's money, mode or
 * effective-from can never change, so an already-settled interval keeps the
 * price it was settled at.
 *
 * `published=false` is the fail-closed state: the service stays ineligible
 * until the operator publishes a REAL tariff (including an explicit 0 Rial
 * "free" row). Absence of a price is never treated as free.
 */
import {
  query,
  withoutTenantScopeTransaction,
  withTenant,
  type PoolClient,
} from "../db";
import { getWalletBalanceRial } from "../wallet-service";
import {
  isServiceKey,
  quoteServiceActivation,
  setupFeeRial,
  type ActivationQuote,
  type ServiceIdentity,
  type ServiceKind,
  type ServiceTariff,
  type SetupMode,
} from "./catalog";

export interface ServicePriceRow extends ServiceTariff {
  id: string;
  serviceKind: ServiceKind;
  serviceKey: string;
  currency: "IRR";
  published: boolean;
  effectiveFrom: string;
  effectiveUntil: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface PriceDbRow {
  [key: string]: unknown;
  id: string;
  service_kind: string;
  service_key: string;
  version: number;
  currency: string;
  setup_mode: string;
  setup_fixed_rial: string | number;
  setup_equivalent_hours: string | number;
  hourly_rate_rial: string | number;
  published: boolean;
  effective_from: Date | string;
  effective_until: Date | string | null;
  note: string | null;
  created_by: string | null;
  created_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPriceRow(row: PriceDbRow): ServicePriceRow {
  return {
    id: row.id,
    serviceKind: row.service_kind as ServiceKind,
    serviceKey: row.service_key,
    version: row.version,
    currency: "IRR",
    setupMode: row.setup_mode as SetupMode,
    setupFixedRial: Number(row.setup_fixed_rial),
    setupEquivalentHours: Number(row.setup_equivalent_hours),
    hourlyRateRial: Number(row.hourly_rate_rial),
    published: row.published,
    effectiveFrom: iso(row.effective_from)!,
    effectiveUntil: iso(row.effective_until),
    note: row.note,
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
  };
}

const SELECT_COLUMNS = `id, service_kind, service_key, version, currency, setup_mode,
       setup_fixed_rial, setup_equivalent_hours, hourly_rate_rial, published,
       effective_from, effective_until, note, created_by, created_at`;

/**
 * The published tariff in force for a service identity at one instant, or null
 * when none covers it (fail closed). Reads the global catalogue, so it needs no
 * tenant scope; callers may still call it inside one.
 */
export async function serviceTariffAt(
  identity: Pick<ServiceIdentity, "kind" | "key">,
  atIso: string = new Date().toISOString(),
  client?: PoolClient,
): Promise<ServicePriceRow | null> {
  const sql = `SELECT ${SELECT_COLUMNS}
                 FROM service_price_schedules
                WHERE service_kind = $1
                  AND service_key = $2
                  AND published
                  AND effective_from <= $3::timestamptz
                  AND (effective_until IS NULL OR effective_until > $3::timestamptz)
                ORDER BY version DESC
                LIMIT 1`;
  const params = [identity.kind, identity.key, atIso];
  const { rows } = client
    ? await client.query<PriceDbRow>(sql, params)
    : await query<PriceDbRow>(sql, params);
  return rows[0] ? toPriceRow(rows[0]) : null;
}

/** The tariff currently in force (what the console edits and the quote shows). */
export async function currentServiceTariff(
  identity: Pick<ServiceIdentity, "kind" | "key">,
): Promise<ServicePriceRow | null> {
  return serviceTariffAt(identity);
}

export interface ServicePriceVersion extends ServicePriceRow {
  /** No closing timestamp: this is the version in force. */
  current: boolean;
}

/**
 * Every price version, newest first, with a `current` flag for the row in
 * force. The console's pricing table reads this.
 */
export async function listServicePrices(): Promise<ServicePriceVersion[]> {
  const { rows } = await query<PriceDbRow & { is_current: boolean }>(
    `SELECT ${SELECT_COLUMNS},
            (effective_until IS NULL) AS is_current
       FROM service_price_schedules
      ORDER BY service_kind, service_key, version DESC`,
  );
  return rows.map((row) => ({ ...toPriceRow(row), current: row.is_current }));
}

export interface PublishServicePriceInput {
  kind: ServiceKind;
  key: string;
  setupMode: SetupMode;
  setupFixedRial?: number;
  setupEquivalentHours?: number;
  hourlyRateRial: number;
  /** false publishes an explicit "not available" version (fail closed). */
  published?: boolean;
  /** ISO instant the new version takes effect; defaults to now. */
  effectiveFrom?: string;
  note?: string | null;
  adminId?: string | null;
}

export class ServicePriceError extends Error {
  constructor(public code: "unknown_service" | "invalid_amount" | "invalid_setup_mode") {
    super(code);
  }
}

function money(value: unknown): number {
  const n = Math.floor(Number(value ?? 0));
  if (!Number.isFinite(n) || n < 0) throw new ServicePriceError("invalid_amount");
  return n;
}

function hours(value: unknown): number {
  const n = Math.round(Number(value ?? 0) * 100) / 100;
  if (!Number.isFinite(n) || n < 0) throw new ServicePriceError("invalid_amount");
  return n;
}

/**
 * Publish a new price version. The previous open row is closed at the same
 * instant, so exactly one version is ever in force. Audited by the caller
 * (`platformAudit`), which is where the operator's identity is recorded.
 */
export async function publishServicePrice(input: PublishServicePriceInput): Promise<ServicePriceRow> {
  const kind = input.kind;
  const key = input.key?.trim() ?? "";
  if (!isServiceKey(kind, key)) throw new ServicePriceError("unknown_service");
  if (input.setupMode !== "fixed" && input.setupMode !== "hour_equivalent") {
    throw new ServicePriceError("invalid_setup_mode");
  }

  const setupFixed = input.setupMode === "fixed" ? money(input.setupFixedRial) : 0;
  const equivalentHours =
    input.setupMode === "hour_equivalent" ? hours(input.setupEquivalentHours) : 0;
  const hourly = money(input.hourlyRateRial);
  const effectiveFrom = input.effectiveFrom
    ? new Date(input.effectiveFrom)
    : new Date();
  if (Number.isNaN(effectiveFrom.getTime())) throw new ServicePriceError("invalid_amount");
  const effectiveIso = effectiveFrom.toISOString();
  const published = input.published !== false;

  return withoutTenantScopeTransaction("platform", async () => {
    // One writer per identity: two simultaneous publishes must not both claim
    // "the next version", and one must not close the other's fresh row.
    await query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
      `service_price:${kind}:${key}`,
    ]);

    await query(
      `UPDATE service_price_schedules
          SET effective_until = $3::timestamptz
        WHERE service_kind = $1 AND service_key = $2 AND effective_until IS NULL`,
      [kind, key, effectiveIso],
    );

    const { rows: maxRows } = await query<{ next_version: string }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM service_price_schedules
        WHERE service_kind = $1 AND service_key = $2`,
      [kind, key],
    );
    const version = Number(maxRows[0]?.next_version ?? 1);

    const { rows } = await query<PriceDbRow>(
      `INSERT INTO service_price_schedules
         (service_kind, service_key, version, setup_mode, setup_fixed_rial,
          setup_equivalent_hours, hourly_rate_rial, published, effective_from,
          note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11)
       RETURNING ${SELECT_COLUMNS}`,
      [
        kind,
        key,
        version,
        input.setupMode,
        setupFixed,
        equivalentHours,
        hourly,
        published,
        effectiveIso,
        input.note?.trim() || null,
        input.adminId ?? null,
      ],
    );
    return toPriceRow(rows[0]);
  });
}

/** The quote the customer sees before confirming — prices, not a debit. */
export async function quoteService(
  businessId: string,
  identity: ServiceIdentity,
): Promise<ActivationQuote> {
  const tariff = await serviceTariffAt(identity);
  const balance = await withTenant(businessId, () => getWalletBalanceRial(businessId));
  return quoteServiceActivation({ identity, tariff, walletBalanceRial: balance });
}

/** The setup fee for a tariff row — re-exported for the console's summary. */
export { setupFeeRial };

/** Everything the console needs for one identity's pricing card. */
export async function servicePricingSummary(
  identity: Pick<ServiceIdentity, "kind" | "key">,
): Promise<{
  current: ServicePriceRow | null;
  versions: ServicePriceRow[];
  setupRial: number;
}> {
  const all = await listServicePrices();
  const versions = all.filter(
    (row) => row.serviceKind === identity.kind && row.serviceKey === identity.key,
  );
  const current = versions.find((row) => row.effectiveUntil == null) ?? null;
  return {
    current,
    versions,
    setupRial: current && current.published ? setupFeeRial(current) : 0,
  };
}
