/**
 * Issue #866 — taxpayer e-invoicing: the write path.
 *
 * Every tax record is created, sent, inquired and corrected here. The rules this
 * file holds to, because a violation would duplicate or rewrite a tax record:
 *
 *   1. A record's identity and payload are fixed when it is prepared. Sending
 *      uses the stored snapshot; nothing is rebuilt from current products or
 *      customers. (The database refuses an update to either.)
 *   2. A sale has one live record. Preparing it twice returns the same record.
 *   3. The authority's uid is generated once, before the first send, and reused
 *      by every retry. A timeout is never resent blind: the record waits in
 *      `awaiting_inquiry` until the authority says what it holds.
 *   4. Each status change is a conditional UPDATE from the expected status, and
 *      writes its history row in the same transaction. A lost race changes nothing.
 *   5. Sending happens outside any database transaction (it is a network call),
 *      bracketed by a lease, so a crashed worker's record is found and inquired,
 *      not lost and not duplicated.
 */
import { randomUUID } from "node:crypto";
import { getBusinessDek } from "./business-keys";
import { query, withTenant, withTenantTransaction, withoutTenantScope } from "./db";
import { decryptOptional } from "./field-crypto";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "./integrations/secrets";
import { TAX_ENVIRONMENTS, TAX_ITEM_CODE_PATTERN, type TaxEnvironment, type TaxKind, type TaxStatus } from "./tax-invoice";
import {
  buildReferenceNumber,
  buildTaxPayload,
  decideAfterInquiry,
  decideAfterSendFailure,
  deriveIdempotencyKey,
  newInvoiceUid,
  TAX_PAYLOAD_VERSION,
  type InquiryOutcome,
  type ProviderIssue,
  type SendFailure,
  type TaxBlocker,
  type TaxParentRef,
  type TaxPayloadV1,
  type TaxSellerProfile,
  type TaxSourceDocument,
} from "./tax-invoice-core";
import { providerFor, TaxProviderFailure, type TaxCredentials } from "./tax-invoice-provider";

export class TaxServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "TaxServiceError";
  }
}

export interface TaxActor {
  businessId: string;
  userId: string | null;
}

/** One structured log line per decision, carrying the record's correlation id. */
export function taxLog(event: string, fields: Record<string, unknown>): void {
  console.info(JSON.stringify({ level: "info", component: "tax-invoice", event, ts: new Date().toISOString(), ...fields }));
}

/** A lease a sender holds while the packet is in flight. Longer than any send timeout. */
const SEND_LEASE_MS = 5 * 60_000;
/** A lease on an inquiry, so two workers do not ask the authority twice at once. */
const INQUIRY_LEASE_MS = 2 * 60_000;
/** The first inquiry after a receipt: the authority needs a moment to process. */
const FIRST_INQUIRY_MS = 60_000;
/** How often the worker looks for due work. Short enough that a sent record is inquired within a minute or two. */
export const TAX_INVOICE_TICK_INTERVAL_MS = 30_000;
/** Largest batch one call handles; the rest waits for the next tick. */
const MAX_BATCH = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE_PREFIX_PATTERN = /^[A-Za-z0-9]{0,8}$/;
const UNIT_CODE_PATTERN = /^[A-Za-z0-9]{1,32}$/;

function requireUuid(value: string, code = "invalid_id"): string {
  if (!UUID_PATTERN.test(value)) throw new TaxServiceError(code, 400, "شناسه نامعتبر است.");
  return value;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface TaxProfileView {
  enabled: boolean;
  environment: TaxEnvironment;
  submissionMode: "direct" | "tsp";
  taxpayerId: string | null;
  taxpayerName: string | null;
  referencePrefix: string;
  credentialsConfigured: boolean;
  updatedAt: string | null;
}

export interface TaxUnitView {
  locationId: string;
  locationName: string;
  memoryId: string | null;
  unitCode: string | null;
}

export interface TaxSettingsView {
  profile: TaxProfileView;
  units: TaxUnitView[];
}

const DEFAULT_PROFILE: TaxProfileView = {
  enabled: false,
  environment: "sandbox",
  submissionMode: "direct",
  taxpayerId: null,
  taxpayerName: null,
  referencePrefix: "",
  credentialsConfigured: false,
  updatedAt: null,
};

export async function getTaxSettings(businessId: string): Promise<TaxSettingsView> {
  return withTenant(businessId, async () => {
    const profileRows = await query<{
      enabled: boolean;
      environment: TaxEnvironment;
      submission_mode: "direct" | "tsp";
      taxpayer_id: string | null;
      taxpayer_name: string | null;
      reference_prefix: string;
      has_credentials: boolean;
      updated_at: Date;
    }>(
      `SELECT enabled, environment, submission_mode, taxpayer_id, taxpayer_name, reference_prefix,
              (credentials_ciphertext IS NOT NULL) AS has_credentials, updated_at
         FROM tax_invoice_profiles WHERE business_id = $1`,
      [businessId],
    );
    const unitRows = await query<{
      location_id: string;
      location_name: string;
      memory_id: string | null;
      unit_code: string | null;
    }>(
      `SELECT l.id AS location_id, l.name AS location_name, u.memory_id, u.unit_code
         FROM locations l
         LEFT JOIN tax_invoice_units u ON u.location_id = l.id AND u.business_id = l.business_id
        WHERE l.business_id = $1 AND l.is_active
        ORDER BY l.name`,
      [businessId],
    );
    const row = profileRows.rows[0];
    const profile: TaxProfileView = row
      ? {
          enabled: row.enabled,
          environment: row.environment,
          submissionMode: row.submission_mode,
          taxpayerId: row.taxpayer_id,
          taxpayerName: row.taxpayer_name,
          referencePrefix: row.reference_prefix,
          credentialsConfigured: row.has_credentials,
          updatedAt: row.updated_at.toISOString(),
        }
      : DEFAULT_PROFILE;
    return {
      profile,
      units: unitRows.rows.map((unit) => ({
        locationId: unit.location_id,
        locationName: unit.location_name,
        memoryId: unit.memory_id,
        unitCode: unit.unit_code,
      })),
    };
  });
}

export interface TaxProfileInput {
  enabled?: boolean;
  environment?: TaxEnvironment;
  submissionMode?: "direct" | "tsp";
  taxpayerId?: string | null;
  taxpayerName?: string | null;
  referencePrefix?: string;
  /**
   * undefined keeps the stored credentials; null clears them; an object is a partial
   * write — the fields it names replace the stored ones and the rest are kept.
   */
  credentials?: TaxCredentials | null;
}

const CREDENTIAL_FIELDS = ["secret", "certificatePem"] as const;

function normalizeCredentials(input: TaxCredentials): TaxCredentials {
  const out: TaxCredentials = {};
  for (const field of CREDENTIAL_FIELDS) {
    const value = input[field];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > 16_000) {
      throw new TaxServiceError("invalid_credentials", 400, "مقدار گواهی یا کلید نامعتبر است.");
    }
    out[field] = value;
  }
  return out;
}

function sealCredentials(credentials: TaxCredentials): string {
  const key = resolveEncryptionKey(process.env as Record<string, string | undefined>);
  return encryptSecret(JSON.stringify(normalizeCredentials(credentials)), key);
}

function openCredentials(ciphertext: string | null): TaxCredentials | null {
  if (!ciphertext) return null;
  const key = resolveEncryptionKey(process.env as Record<string, string | undefined>);
  return JSON.parse(decryptSecret(ciphertext, key)) as TaxCredentials;
}

export async function saveTaxProfile(actor: TaxActor, input: TaxProfileInput): Promise<void> {
  if (input.environment !== undefined && !TAX_ENVIRONMENTS.includes(input.environment)) {
    throw new TaxServiceError("invalid_environment", 400, "محیط ارسال نامعتبر است.");
  }
  if (input.submissionMode !== undefined && input.submissionMode !== "direct" && input.submissionMode !== "tsp") {
    throw new TaxServiceError("invalid_submission_mode", 400, "روش ارسال نامعتبر است.");
  }
  if (input.referencePrefix !== undefined && !REFERENCE_PREFIX_PATTERN.test(input.referencePrefix)) {
    throw new TaxServiceError("invalid_reference_prefix", 400, "پیشوند شماره ارجاع فقط حروف و عدد لاتین می‌پذیرد.");
  }
  const taxpayerId = input.taxpayerId === undefined ? undefined : input.taxpayerId?.trim() || null;
  if (taxpayerId !== undefined && taxpayerId !== null && !/^[0-9A-Za-z]{1,32}$/.test(taxpayerId)) {
    throw new TaxServiceError("invalid_taxpayer_id", 400, "شناسه مؤدی نامعتبر است.");
  }
  const taxpayerName = input.taxpayerName === undefined ? undefined : input.taxpayerName?.trim() || null;
  if (taxpayerName !== undefined && taxpayerName !== null && taxpayerName.length > 200) {
    throw new TaxServiceError("invalid_taxpayer_name", 400, "نام مؤدی بیش از حد طولانی است.");
  }
  let credentialsChanged = false;
  await withTenantTransaction(actor.businessId, async () => {
    // A credentials object is a partial write: a field it leaves out keeps the
    // stored value, so entering a new key does not discard the certificate.
    // null clears both; undefined leaves them alone.
    let sealed: string | null | undefined;
    if (input.credentials === undefined || input.credentials === null) {
      sealed = input.credentials;
    } else {
      const stored = await query<{ credentials_ciphertext: string | null }>(
        `SELECT credentials_ciphertext FROM tax_invoice_profiles WHERE business_id = $1`,
        [actor.businessId],
      );
      const previous = openCredentials(stored.rows[0]?.credentials_ciphertext ?? null) ?? {};
      sealed = sealCredentials({ ...previous, ...normalizeCredentials(input.credentials) });
    }
    credentialsChanged = sealed !== undefined;

    await query(
      `INSERT INTO tax_invoice_profiles
         (business_id, enabled, environment, submission_mode, taxpayer_id, taxpayer_name, reference_prefix,
          credentials_ciphertext, updated_at, updated_by)
       VALUES ($1, COALESCE($2::boolean, false), COALESCE($3::text, 'sandbox'), COALESCE($4::text, 'direct'),
               $5::text, $6::text, COALESCE($7::text, ''), $8::text, now(), $9::uuid)
       ON CONFLICT (business_id) DO UPDATE SET
         enabled = COALESCE($2::boolean, tax_invoice_profiles.enabled),
         environment = COALESCE($3::text, tax_invoice_profiles.environment),
         submission_mode = COALESCE($4::text, tax_invoice_profiles.submission_mode),
         taxpayer_id = CASE WHEN $10::boolean THEN $5::text ELSE tax_invoice_profiles.taxpayer_id END,
         taxpayer_name = CASE WHEN $11::boolean THEN $6::text ELSE tax_invoice_profiles.taxpayer_name END,
         reference_prefix = COALESCE($7::text, tax_invoice_profiles.reference_prefix),
         credentials_ciphertext = CASE WHEN $12::boolean THEN $8::text ELSE tax_invoice_profiles.credentials_ciphertext END,
         updated_at = now(),
         updated_by = $9::uuid`,
      [
        actor.businessId,
        input.enabled ?? null,
        input.environment ?? null,
        input.submissionMode ?? null,
        taxpayerId ?? null,
        taxpayerName ?? null,
        input.referencePrefix ?? null,
        sealed ?? null,
        actor.userId,
        taxpayerId !== undefined,
        taxpayerName !== undefined,
        sealed !== undefined,
      ],
    );

    const check = await query<{ enabled: boolean; taxpayer_id: string | null }>(
      `SELECT enabled, taxpayer_id FROM tax_invoice_profiles WHERE business_id = $1`,
      [actor.businessId],
    );
    if (check.rows[0]?.enabled && !check.rows[0].taxpayer_id) {
      throw new TaxServiceError("taxpayer_id_required", 409, "پیش از فعال‌سازی، شناسه مؤدی را وارد کنید.");
    }

    // The audit names what changed. It never carries a secret, not even a length.
    const changed = Object.keys(input).filter((key) => key !== "credentials");
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1::uuid, $2::uuid, 'tax_invoice.settings_updated', 'tax_invoice_profile', $3::text, $4::jsonb)`,
      [
        actor.businessId,
        actor.userId,
        actor.businessId,
        JSON.stringify({ changed, credentialsChanged, environment: input.environment ?? null }),
      ],
    );
  });
  taxLog("settings.updated", { businessId: actor.businessId, credentialsChanged });
}

export interface TaxUnitInput {
  locationId: string;
  memoryId: string | null;
  unitCode?: string | null;
}

export async function saveTaxUnits(actor: TaxActor, units: readonly TaxUnitInput[]): Promise<void> {
  if (units.length > 100) throw new TaxServiceError("too_many_units", 400, "تعداد شعبه‌ها بیش از حد است.");
  const cleaned = units.map((unit) => {
    requireUuid(unit.locationId, "invalid_location");
    const memoryId = unit.memoryId?.trim() || null;
    if (memoryId !== null && memoryId.length > 64) {
      throw new TaxServiceError("invalid_memory_id", 400, "شناسه حافظه مالیاتی نامعتبر است.");
    }
    const unitCode = unit.unitCode?.trim() || null;
    if (unitCode !== null && !UNIT_CODE_PATTERN.test(unitCode)) {
      throw new TaxServiceError("invalid_unit_code", 400, "کد واحد فقط حروف و عدد لاتین می‌پذیرد.");
    }
    return { locationId: unit.locationId, memoryId, unitCode };
  });

  await withTenantTransaction(actor.businessId, async () => {
    for (const unit of cleaned) {
      const location = await query(`SELECT id FROM locations WHERE id = $1 AND business_id = $2`, [unit.locationId, actor.businessId]);
      if (location.rowCount === 0) throw new TaxServiceError("location_not_found", 404, "شعبه پیدا نشد.");
      if (unit.memoryId === null) {
        await query(`DELETE FROM tax_invoice_units WHERE business_id = $1 AND location_id = $2`, [actor.businessId, unit.locationId]);
        continue;
      }
      await query(
        `INSERT INTO tax_invoice_units (business_id, location_id, memory_id, unit_code)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (business_id, location_id)
         DO UPDATE SET memory_id = EXCLUDED.memory_id, unit_code = EXCLUDED.unit_code, updated_at = now()`,
        [actor.businessId, unit.locationId, unit.memoryId, unit.unitCode],
      );
    }
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1::uuid, $2::uuid, 'tax_invoice.units_updated', 'tax_invoice_unit', $3::text, $4::jsonb)`,
      [actor.businessId, actor.userId, actor.businessId, JSON.stringify({ locations: cleaned.map((unit) => unit.locationId) })],
    );
  });
}

export interface ProductNeedingCode {
  productKind: "menu_item" | "item";
  productId: string;
  name: string;
  soldLines: number;
  lastSoldAt: string | null;
}

/** Products that have been sold and still lack their «شناسه کالا/خدمت». */
export async function listProductsWithoutCodes(businessId: string, limit = 200): Promise<ProductNeedingCode[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<{
      product_kind: "menu_item" | "item";
      product_id: string;
      name: string;
      sold_lines: number;
      last_sold_at: Date | null;
    }>(
      `SELECT * FROM (
         SELECT 'menu_item'::text AS product_kind, oi.menu_item_id AS product_id, MAX(oi.name_snapshot) AS name,
                COUNT(*)::int AS sold_lines, MAX(COALESCE(o.closed_at, o.opened_at)) AS last_sold_at
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.status = 'completed' AND oi.status <> 'voided' AND oi.menu_item_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tax_item_codes c WHERE c.business_id = $1 AND c.product_id = oi.menu_item_id)
          GROUP BY oi.menu_item_id
         UNION ALL
         SELECT 'item'::text, oi.item_id, MAX(oi.name_snapshot), COUNT(*)::int, MAX(COALESCE(o.closed_at, o.opened_at))
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.status = 'completed' AND oi.status <> 'voided' AND oi.item_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tax_item_codes c WHERE c.business_id = $1 AND c.product_id = oi.item_id)
          GROUP BY oi.item_id
       ) products
       ORDER BY last_sold_at DESC NULLS LAST
       LIMIT $2`,
      [businessId, limit],
    );
    return rows.map((row) => ({
      productKind: row.product_kind,
      productId: row.product_id,
      name: row.name,
      soldLines: row.sold_lines,
      lastSoldAt: row.last_sold_at ? row.last_sold_at.toISOString() : null,
    }));
  });
}

export interface TaxItemCodeInput {
  productKind: "menu_item" | "item";
  productId: string;
  code: string | null;
}

export async function saveTaxItemCodes(actor: TaxActor, codes: readonly TaxItemCodeInput[]): Promise<void> {
  if (codes.length > 500) throw new TaxServiceError("too_many_codes", 400, "تعداد شناسه‌ها بیش از حد است.");
  for (const entry of codes) {
    requireUuid(entry.productId, "invalid_product");
    if (entry.productKind !== "menu_item" && entry.productKind !== "item") {
      throw new TaxServiceError("invalid_product_kind", 400, "نوع کالا نامعتبر است.");
    }
    if (entry.code !== null && !TAX_ITEM_CODE_PATTERN.test(entry.code.trim())) {
      throw new TaxServiceError("invalid_item_code", 400, "شناسه کالا/خدمت باید ۱۳ رقم باشد.");
    }
  }

  await withTenantTransaction(actor.businessId, async () => {
    for (const entry of codes) {
      const table = entry.productKind === "menu_item" ? "menu_items" : "items";
      // The product must exist in this tenant. RLS hides another tenant's rows, so
      // a foreign id is "not found" here rather than a code attached to it.
      const exists = await query(`SELECT 1 FROM ${table} WHERE id = $1`, [entry.productId]);
      if (exists.rowCount === 0) throw new TaxServiceError("product_not_found", 404, "کالا پیدا نشد.");
      if (entry.code === null) {
        await query(
          `DELETE FROM tax_item_codes WHERE business_id = $1 AND product_kind = $2 AND product_id = $3`,
          [actor.businessId, entry.productKind, entry.productId],
        );
        continue;
      }
      await query(
        `INSERT INTO tax_item_codes (business_id, product_kind, product_id, code)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (business_id, product_kind, product_id)
         DO UPDATE SET code = EXCLUDED.code, updated_at = now()`,
        [actor.businessId, entry.productKind, entry.productId, entry.code.trim()],
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Records: loading, creating
// ---------------------------------------------------------------------------

export interface TaxRecordRow {
  id: string;
  location_id: string;
  order_id: string;
  kind: TaxKind;
  revision: number;
  parent_submission_id: string | null;
  idempotency_key: string;
  reference_number: string;
  uid: string;
  receipt_id: string | null;
  environment: TaxEnvironment;
  provider: "sandbox" | "moodian";
  payload_snapshot: TaxPayloadV1;
  payload_hash: string;
  total_rial: number;
  vat_rial: number;
  status: TaxStatus;
  attempts: number;
  next_attempt_at: Date | null;
  leased_until: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  provider_errors: ProviderIssue[];
  correlation_id: string;
}

const RECORD_COLUMNS = `id, location_id, order_id, kind, revision, parent_submission_id, idempotency_key,
  reference_number, uid, receipt_id, environment, provider, payload_snapshot, payload_hash,
  total_rial::bigint AS total_rial, vat_rial::bigint AS vat_rial, status, attempts, next_attempt_at, leased_until,
  last_error_code, last_error_message, provider_errors, correlation_id`;

function mapRecord(row: Record<string, unknown>): TaxRecordRow {
  return {
    ...(row as unknown as TaxRecordRow),
    total_rial: Number(row.total_rial),
    vat_rial: Number(row.vat_rial),
  };
}

async function recordEvent(
  businessId: string,
  submissionId: string,
  event: {
    type: string;
    from?: TaxStatus | null;
    to?: TaxStatus | null;
    actorUserId?: string | null;
    correlationId: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await query(
    `INSERT INTO tax_invoice_events
       (business_id, submission_id, event_type, from_status, to_status, actor_user_id, correlation_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      businessId,
      submissionId,
      event.type,
      event.from ?? null,
      event.to ?? null,
      event.actorUserId ?? null,
      event.correlationId,
      JSON.stringify(event.detail ?? {}),
    ],
  );
}

async function loadRecord(id: string, lock = false): Promise<TaxRecordRow | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${RECORD_COLUMNS} FROM tax_invoice_submissions WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ? mapRecord(rows[0]) : null;
}

async function loadProfileForPrepare(): Promise<{
  enabled: boolean;
  environment: TaxEnvironment;
  submissionMode: "direct" | "tsp";
  taxpayerId: string | null;
  taxpayerName: string | null;
  referencePrefix: string;
} | null> {
  const { rows } = await query<{
    enabled: boolean;
    environment: TaxEnvironment;
    submission_mode: "direct" | "tsp";
    taxpayer_id: string | null;
    taxpayer_name: string | null;
    reference_prefix: string;
  }>(
    `SELECT enabled, environment, submission_mode, taxpayer_id, taxpayer_name, reference_prefix
       FROM tax_invoice_profiles`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    enabled: row.enabled,
    environment: row.environment,
    submissionMode: row.submission_mode,
    taxpayerId: row.taxpayer_id,
    taxpayerName: row.taxpayer_name,
    referencePrefix: row.reference_prefix,
  };
}

/**
 * The buyer's economic code. The ciphertext is the record; the plaintext twin
 * only bridges the transition, so it is read only when no ciphertext exists.
 * Without a key on this install the plaintext is the best available answer.
 */
async function buyerEconomicCode(businessId: string, enc: unknown, plain: string | null): Promise<string | null> {
  if (enc === null || enc === undefined) return plain;
  return decryptOptional(enc, await getBusinessDek(businessId), plain);
}

/** The internal sale as it stands now. Runs inside the tenant scope of `businessId`. */
async function loadOrderSource(businessId: string, orderId: string): Promise<{
  source: TaxSourceDocument;
  locationId: string;
  orderNumber: number;
} | null> {
  const orderRows = await query<{
    id: string;
    order_number: string;
    location_id: string;
    location_name: string;
    status: string;
    closed_at: Date;
    subtotal: string;
    discount: string;
    service_charge: string;
    tax: string;
    total: string;
    buyer_id: string | null;
    buyer_name: string | null;
    buyer_economic_code: string | null;
    buyer_economic_code_enc: unknown;
  }>(
    `SELECT o.id, o.order_number, o.location_id, l.name AS location_name, o.status,
            COALESCE(o.closed_at, o.opened_at) AS closed_at,
            o.subtotal, o.discount, o.service_charge, o.tax, o.total,
            o.customer_id AS buyer_id, p.name AS buyer_name, p.economic_code AS buyer_economic_code,
            p.economic_code_enc AS buyer_economic_code_enc
       FROM orders o
       JOIN locations l ON l.id = o.location_id
       LEFT JOIN parties p ON p.id = o.customer_id
      WHERE o.id = $1`,
    [orderId],
  );
  const order = orderRows.rows[0];
  if (!order) return null;

  const lineRows = await query<{
    product_kind: "menu_item" | "item" | null;
    product_id: string | null;
    name_snapshot: string;
    quantity: number;
    unit_price: string;
    modifiers: string;
    tax_code: string | null;
  }>(
    `SELECT CASE WHEN oi.menu_item_id IS NOT NULL THEN 'menu_item' WHEN oi.item_id IS NOT NULL THEN 'item' END AS product_kind,
            COALESCE(oi.menu_item_id, oi.item_id) AS product_id,
            oi.name_snapshot, oi.quantity, oi.unit_price,
            COALESCE((SELECT SUM(oim.price_delta * oim.quantity) FROM order_item_modifiers oim WHERE oim.order_item_id = oi.id), 0) AS modifiers,
            c.code AS tax_code
       FROM order_items oi
       LEFT JOIN tax_item_codes c
              ON c.business_id = $2
             AND c.product_id = COALESCE(oi.menu_item_id, oi.item_id)
             AND c.product_kind = CASE WHEN oi.menu_item_id IS NOT NULL THEN 'menu_item' ELSE 'item' END
      WHERE oi.order_id = $1 AND oi.status <> 'voided'
      ORDER BY oi.created_at, oi.id`,
    [orderId, businessId],
  );

  const lines = lineRows.rows.map((line) => ({
    productKind: line.product_kind,
    productId: line.product_id,
    name: line.name_snapshot,
    quantity: line.quantity,
    unitPriceRial: Number(line.unit_price),
    modifiersRial: Number(line.modifiers),
    taxCode: line.tax_code,
  }));

  return {
    orderNumber: Number(order.order_number),
    locationId: order.location_id,
    source: {
      orderId: order.id,
      orderNumber: Number(order.order_number),
      locationId: order.location_id,
      locationName: order.location_name,
      orderStatus: order.status,
      closedAt: order.closed_at.toISOString(),
      subtotalRial: Number(order.subtotal),
      discountRial: Number(order.discount),
      serviceChargeRial: Number(order.service_charge),
      vatRial: Number(order.tax),
      totalRial: Number(order.total),
      buyer: {
        partyId: order.buyer_id,
        name: order.buyer_name,
        economicCode: await buyerEconomicCode(businessId, order.buyer_economic_code_enc, order.buyer_economic_code),
      },
      lines,
    },
  };
}

/**
 * The source of a cancellation is the record it cancels, as it was sent. A
 * cancellation reproduces the invoice it withdraws; it never reads the sale as
 * it stands today, so a later price change cannot alter what gets withdrawn.
 */
function sourceFromPayload(payload: TaxPayloadV1): TaxSourceDocument {
  return {
    orderId: payload.source.orderId,
    orderNumber: payload.source.orderNumber,
    locationId: payload.source.locationId,
    locationName: payload.source.locationName,
    orderStatus: "completed",
    closedAt: payload.source.closedAt,
    subtotalRial: payload.totals.subtotalRial,
    discountRial: payload.totals.discountRial,
    serviceChargeRial: 0,
    vatRial: payload.totals.vatRial,
    totalRial: payload.totals.totalRial,
    buyer: payload.buyer,
    lines: payload.lines.map((line) => ({
      productKind: line.productKind,
      productId: line.productId,
      name: line.name,
      quantity: line.quantity,
      unitPriceRial: line.unitPriceRial,
      modifiersRial: line.modifiersRial,
      taxCode: line.taxCode,
    })),
  };
}

type CreateOutcome =
  | { outcome: "created"; record: TaxRecordRow }
  | { outcome: "existing"; record: TaxRecordRow }
  | { outcome: "blocked"; blockers: TaxBlocker[] };

interface CreateInput {
  orderId: string;
  kind: TaxKind;
  parent: TaxRecordRow | null;
  reason: string | null;
  correlationId: string;
}

/**
 * Create one prepared record for an order. Runs inside the caller's tenant
 * transaction and takes the order's row lock first, so two prepares of the same
 * order serialise and the second finds the first's record.
 */
async function createRecord(actor: TaxActor, input: CreateInput): Promise<CreateOutcome> {
  const lock = await query<{ id: string }>(`SELECT id FROM orders WHERE id = $1 FOR UPDATE`, [input.orderId]);
  if (lock.rowCount === 0) throw new TaxServiceError("order_not_found", 404, "فروش پیدا نشد.");

  if (input.kind === "sale") {
    const live = await query<Record<string, unknown>>(
      `SELECT ${RECORD_COLUMNS} FROM tax_invoice_submissions
        WHERE order_id = $1 AND kind = 'sale' AND status NOT IN ('rejected', 'cancelled')
        ORDER BY revision DESC LIMIT 1`,
      [input.orderId],
    );
    if (live.rows[0]) return { outcome: "existing", record: mapRecord(live.rows[0]) };
  } else if (input.parent) {
    const child = await query<Record<string, unknown>>(
      `SELECT ${RECORD_COLUMNS} FROM tax_invoice_submissions
        WHERE parent_submission_id = $1 AND status NOT IN ('rejected', 'cancelled') LIMIT 1`,
      [input.parent.id],
    );
    if (child.rows[0]) return { outcome: "existing", record: mapRecord(child.rows[0]) };
  }

  const profile = await loadProfileForPrepare();
  const blockers: TaxBlocker[] = [];
  if (!profile) {
    blockers.push({ code: "profile_not_configured", message: "تنظیمات مؤدی هنوز ذخیره نشده است." });
  } else if (!profile.enabled) {
    blockers.push({ code: "profile_disabled", message: "صدور صورتحساب مؤدی برای این کسب‌وکار فعال نیست." });
  }

  const loaded = await loadOrderSource(actor.businessId, input.orderId);
  if (!loaded) throw new TaxServiceError("order_not_found", 404, "فروش پیدا نشد.");

  const unitRows = await query<{ memory_id: string; unit_code: string | null }>(
    `SELECT memory_id, unit_code FROM tax_invoice_units WHERE location_id = $1`,
    [loaded.locationId],
  );
  const unit = unitRows.rows[0] ?? null;

  const revisionRow = await query<{ next: number }>(
    `SELECT COALESCE(MAX(revision), 0)::int + 1 AS next FROM tax_invoice_submissions WHERE order_id = $1 AND kind = $2`,
    [input.orderId, input.kind],
  );
  const revision = revisionRow.rows[0].next;

  const parentRef: TaxParentRef | null = input.parent
    ? {
        submissionId: input.parent.id,
        kind: input.parent.kind,
        uid: input.parent.uid,
        reference: input.parent.reference_number,
        receiptId: input.parent.receipt_id,
      }
    : null;

  if (blockers.length > 0) return { outcome: "blocked", blockers };

  const seller: TaxSellerProfile = {
    taxpayerId: profile!.taxpayerId ?? "",
    taxpayerName: profile!.taxpayerName,
    memoryId: unit?.memory_id ?? "",
    unitCode: unit?.unit_code ?? null,
    environment: profile!.environment,
    submissionMode: profile!.submissionMode,
  };
  const reference = buildReferenceNumber({
    prefix: profile!.referencePrefix,
    unitCode: unit?.unit_code ?? null,
    locationId: loaded.locationId,
    orderNumber: loaded.orderNumber,
    kind: input.kind,
    revision,
  });
  const uid = newInvoiceUid();
  const source = input.kind === "cancellation" && input.parent ? sourceFromPayload(input.parent.payload_snapshot) : loaded.source;
  const built = buildTaxPayload({
    kind: input.kind,
    revision,
    reference,
    uid,
    issuedAt: new Date().toISOString(),
    seller,
    source,
    parent: parentRef,
    reason: input.reason,
  });
  if (!built.ok) return { outcome: "blocked", blockers: built.blockers };

  const idempotencyKey = deriveIdempotencyKey({
    businessId: actor.businessId,
    orderId: input.orderId,
    kind: input.kind,
    revision,
    parentSubmissionId: input.parent?.id ?? null,
  });
  const { payload, hash } = built;
  const inserted = await query<{ id: string }>(
    `INSERT INTO tax_invoice_submissions
       (business_id, location_id, order_id, kind, revision, parent_submission_id, idempotency_key,
        reference_number, uid, environment, provider, payload_version, payload_snapshot, payload_hash,
        subtotal_rial, discount_rial, vat_rial, total_rial, status, correlation_id, prepared_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18,
             'prepared', $19, $20)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      actor.businessId,
      loaded.locationId,
      input.orderId,
      input.kind,
      revision,
      input.parent?.id ?? null,
      idempotencyKey,
      reference,
      uid,
      payload.seller.environment,
      payload.seller.environment === "sandbox" ? "sandbox" : "moodian",
      TAX_PAYLOAD_VERSION,
      JSON.stringify(payload),
      hash,
      payload.totals.subtotalRial,
      payload.totals.discountRial,
      payload.totals.vatRial,
      payload.totals.totalRial,
      input.correlationId,
      actor.userId,
    ],
  );

  if (inserted.rowCount === 0) {
    // A concurrent prepare, or a retry of the same decision, already holds the row.
    const existing = await query<Record<string, unknown>>(
      `SELECT ${RECORD_COLUMNS} FROM tax_invoice_submissions WHERE business_id = $1 AND idempotency_key = $2`,
      [actor.businessId, idempotencyKey],
    );
    if (existing.rows[0]) return { outcome: "existing", record: mapRecord(existing.rows[0]) };
    throw new TaxServiceError("reference_conflict", 409, "شماره ارجاع تکراری است.");
  }

  const created = await loadRecord(inserted.rows[0].id);
  if (!created) throw new TaxServiceError("record_missing", 500);
  await recordEvent(actor.businessId, created.id, {
    type: "prepared",
    to: "prepared",
    actorUserId: actor.userId,
    correlationId: input.correlationId,
    detail: { kind: input.kind, revision, reference, payloadHash: hash, parentId: input.parent?.id ?? null },
  });
  taxLog("record.prepared", { correlationId: input.correlationId, submissionId: created.id, kind: input.kind, revision, reference });
  return { outcome: "created", record: created };
}

export interface PrepareResult {
  orderId: string;
  outcome: "prepared" | "existing" | "blocked" | "failed";
  submissionId: string | null;
  reference: string | null;
  blockers: TaxBlocker[];
  error: string | null;
}

/** Prepare sales in batch. One order's failure does not stop the others. */
export async function prepareSales(actor: TaxActor, orderIds: readonly string[]): Promise<PrepareResult[]> {
  if (orderIds.length > MAX_BATCH) throw new TaxServiceError("batch_too_large", 400, `حداکثر ${MAX_BATCH} فروش در هر بار.`);
  const unique = [...new Set(orderIds.map((id) => requireUuid(id, "invalid_order")))];
  const results: PrepareResult[] = [];
  for (const orderId of unique) {
    const correlationId = randomUUID();
    try {
      const outcome = await withTenantTransaction(actor.businessId, () =>
        createRecord(actor, { orderId, kind: "sale", parent: null, reason: null, correlationId }),
      );
      if (outcome.outcome === "blocked") {
        results.push({ orderId, outcome: "blocked", submissionId: null, reference: null, blockers: outcome.blockers, error: null });
      } else {
        results.push({
          orderId,
          outcome: outcome.outcome === "created" ? "prepared" : "existing",
          submissionId: outcome.record.id,
          reference: outcome.record.reference_number,
          blockers: [],
          error: null,
        });
      }
    } catch (error) {
      const message = error instanceof TaxServiceError ? error.code : "prepare_failed";
      results.push({ orderId, outcome: "failed", submissionId: null, reference: null, blockers: [], error: message });
      if (!(error instanceof TaxServiceError)) taxLog("record.prepare_failed", { correlationId, orderId, error: String(error) });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Mark prepared records as queued, then send what is due now. */
export async function queueAndSend(actor: TaxActor, ids: readonly string[]): Promise<{ id: string; status: TaxStatus | null; skipped: string | null }[]> {
  if (ids.length > MAX_BATCH) throw new TaxServiceError("batch_too_large", 400, `حداکثر ${MAX_BATCH} صورتحساب در هر بار.`);
  const unique = [...new Set(ids.map((id) => requireUuid(id)))];
  const skipped = new Map<string, string>();
  await withTenantTransaction(actor.businessId, async () => {
    for (const id of unique) {
      const record = await loadRecord(id, true);
      if (!record) {
        skipped.set(id, "not_found");
        continue;
      }
      if (record.status !== "prepared") {
        skipped.set(id, record.status === "queued" ? "already_queued" : `status_${record.status}`);
        continue;
      }
      await query(
        `UPDATE tax_invoice_submissions SET status = 'queued', queued_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'prepared'`,
        [id],
      );
      await recordEvent(actor.businessId, id, {
        type: "queued",
        from: "prepared",
        to: "queued",
        actorUserId: actor.userId,
        correlationId: record.correlation_id,
      });
    }
  });
  const sendable = unique.filter((id) => !skipped.has(id) || skipped.get(id) === "already_queued");
  await drainSubmissions(actor.businessId, { ids: sendable, now: new Date(), limit: MAX_BATCH });
  const after = await withTenant(actor.businessId, () =>
    query<{ id: string; status: TaxStatus }>(`SELECT id, status FROM tax_invoice_submissions WHERE id = ANY($1::uuid[])`, [unique]),
  );
  const statusOf = new Map(after.rows.map((row) => [row.id, row.status]));
  return unique.map((id) => ({ id, status: statusOf.get(id) ?? null, skipped: skipped.get(id) ?? null }));
}

interface ClaimedRecord extends TaxRecordRow {
  attempts: number;
}

/**
 * Claim due queued records for sending: `queued` → `sending`, under a lease. The
 * claim is `FOR UPDATE SKIP LOCKED`, so two workers never hold the same record.
 */
async function claimForSend(businessId: string, ids: readonly string[] | null, now: Date, limit: number): Promise<ClaimedRecord[]> {
  return withTenantTransaction(businessId, async () => {
    const { rows } = await query<Record<string, unknown>>(
      `UPDATE tax_invoice_submissions
          SET status = 'sending', leased_until = $2::timestamptz + make_interval(secs => $3::int), updated_at = now()
        WHERE id IN (
          SELECT id FROM tax_invoice_submissions
           WHERE business_id = $1 AND status = 'queued'
             AND (next_attempt_at IS NULL OR next_attempt_at <= $2::timestamptz)
             AND ($4::uuid[] IS NULL OR id = ANY($4::uuid[]))
           ORDER BY next_attempt_at NULLS FIRST, prepared_at, id
           LIMIT $5
           FOR UPDATE SKIP LOCKED)
      RETURNING ${RECORD_COLUMNS}, attempts`,
      [businessId, now, Math.round(SEND_LEASE_MS / 1000), ids ? [...ids] : null, limit],
    );
    for (const row of rows) {
      await recordEvent(businessId, row.id as string, {
        type: "send_started",
        from: "queued",
        to: "sending",
        correlationId: row.correlation_id as string,
        detail: { attempt: Number(row.attempts) + 1 },
      });
    }
    return rows.map((row) => ({ ...mapRecord(row), attempts: Number(row.attempts) }));
  });
}

/**
 * A sending record whose lease ran out: the worker died or stalled mid-send. The
 * packet may or may not have arrived, so it goes to inquiry, never to a resend.
 */
async function recoverExpiredSendLeases(businessId: string, now: Date): Promise<number> {
  return withTenantTransaction(businessId, async () => {
    const { rows } = await query<{ id: string; correlation_id: string }>(
      `UPDATE tax_invoice_submissions
          SET status = 'awaiting_inquiry', leased_until = NULL, next_attempt_at = $1::timestamptz,
              last_error_code = 'lease_expired',
              last_error_message = 'ارسال قطع شد؛ پیش از هر ارسال مجدد، وضعیت از سامانه استعلام می‌شود.',
              updated_at = now()
        WHERE business_id = $2 AND status = 'sending' AND leased_until < $1::timestamptz
      RETURNING id, correlation_id`,
      [now, businessId],
    );
    for (const row of rows) {
      await recordEvent(businessId, row.id, {
        type: "lease_expired",
        from: "sending",
        to: "awaiting_inquiry",
        correlationId: row.correlation_id,
      });
      taxLog("record.lease_expired", { correlationId: row.correlation_id, submissionId: row.id });
    }
    return rows.length;
  });
}

async function sendOne(businessId: string, record: ClaimedRecord, credentials: TaxCredentials | null, now: Date): Promise<void> {
  const adapter = providerFor(record.environment);
  try {
    const { receiptId } = await adapter.submit({
      uid: record.uid,
      reference: record.reference_number,
      environment: record.environment,
      payload: record.payload_snapshot,
      credentials,
    });
    await withTenantTransaction(businessId, async () => {
      const updated = await query(
        `UPDATE tax_invoice_submissions
            SET status = 'submitted', receipt_id = $2, attempts = attempts + 1, submitted_at = now(),
                leased_until = NULL, next_attempt_at = $3::timestamptz,
                last_error_code = NULL, last_error_message = NULL, provider_errors = '[]'::jsonb, updated_at = now()
          WHERE id = $1 AND status = 'sending'`,
        [record.id, receiptId, new Date(now.getTime() + FIRST_INQUIRY_MS)],
      );
      if (updated.rowCount === 1) {
        await recordEvent(businessId, record.id, {
          type: "submitted",
          from: "sending",
          to: "submitted",
          correlationId: record.correlation_id,
          detail: { receiptId },
        });
      }
    });
    taxLog("record.submitted", { correlationId: record.correlation_id, submissionId: record.id, provider: adapter.provider });
  } catch (error) {
    const failure: SendFailure =
      error instanceof TaxProviderFailure
        ? error.failure
        : {
            kind: "unknown_delivery",
            code: "send_error",
            message: "ارسال با خطای ناشناخته پاسخ داد؛ پیش از ارسال مجدد استعلام می‌شود.",
          };
    const decision = decideAfterSendFailure(failure, record.attempts, now);
    await withTenantTransaction(businessId, async () => {
      const updated = await query(
        `UPDATE tax_invoice_submissions
            SET status = $2, attempts = $3, next_attempt_at = $4::timestamptz, leased_until = NULL,
                last_error_code = $5, last_error_message = $6, provider_errors = $7::jsonb, updated_at = now()
          WHERE id = $1 AND status = 'sending'`,
        [
          record.id,
          decision.status,
          decision.attempts,
          decision.nextAttemptAt,
          decision.errorCode,
          decision.errorMessage,
          JSON.stringify(decision.providerErrors),
        ],
      );
      if (updated.rowCount === 1) {
        await recordEvent(businessId, record.id, {
          type: "send_failed",
          from: "sending",
          to: decision.status,
          correlationId: record.correlation_id,
          detail: { failure: failure.kind, code: decision.errorCode, attempts: decision.attempts },
        });
      }
    });
    taxLog("record.send_failed", {
      correlationId: record.correlation_id,
      submissionId: record.id,
      failure: failure.kind,
      to: decision.status,
      code: decision.errorCode,
    });
  }
}

export interface DrainSummary {
  claimed: number;
  submitted: number;
  failed: number;
  inquired: number;
  leasesRecovered: number;
}

/** Send the due queued records of one business, then inquire the ones awaiting a result. */
export async function drainSubmissions(
  businessId: string,
  options: { ids?: readonly string[]; now?: Date; limit?: number } = {},
): Promise<Pick<DrainSummary, "claimed" | "submitted" | "failed">> {
  const now = options.now ?? new Date();
  const limit = Math.min(options.limit ?? MAX_BATCH, MAX_BATCH);
  const credentials = await withTenant(businessId, async () => {
    const { rows } = await query<{ credentials_ciphertext: string | null }>(
      `SELECT credentials_ciphertext FROM tax_invoice_profiles WHERE business_id = $1`,
      [businessId],
    );
    return openCredentials(rows[0]?.credentials_ciphertext ?? null);
  });
  const claimed = await claimForSend(businessId, options.ids ?? null, now, limit);
  let submitted = 0;
  let failed = 0;
  for (const record of claimed) {
    await sendOne(businessId, record, credentials, now);
    const after = await withTenant(businessId, () => loadRecord(record.id));
    if (after?.status === "submitted") submitted += 1;
    else failed += 1;
  }
  return { claimed: claimed.length, submitted, failed };
}

// ---------------------------------------------------------------------------
// Inquiry
// ---------------------------------------------------------------------------

type InquiryClaim = {
  id: string;
  status: TaxStatus;
  uid: string;
  reference_number: string;
  receipt_id: string | null;
  environment: TaxEnvironment;
  attempts: number;
  kind: TaxKind;
  parent_submission_id: string | null;
  correlation_id: string;
};

/**
 * Ask the authority about records that are awaiting a result. Due records only,
 * unless `force` names them, which is how an operator's «استعلام» reaches a
 * record the schedule has not yet reached.
 */
async function claimForInquiry(businessId: string, ids: readonly string[] | null, now: Date, limit: number, force: boolean): Promise<InquiryClaim[]> {
  return withTenantTransaction(businessId, async () => {
    const { rows } = await query<InquiryClaim>(
      `SELECT id, status, uid, reference_number, receipt_id, environment, attempts, kind, parent_submission_id, correlation_id
         FROM tax_invoice_submissions
        WHERE business_id = $1 AND status IN ('submitted', 'awaiting_inquiry')
          AND (leased_until IS NULL OR leased_until < $2::timestamptz)
          AND ($3::boolean OR next_attempt_at IS NULL OR next_attempt_at <= $2::timestamptz)
          AND ($4::uuid[] IS NULL OR id = ANY($4::uuid[]))
        ORDER BY next_attempt_at NULLS FIRST, id
        LIMIT $5
        FOR UPDATE SKIP LOCKED`,
      [businessId, now, force, ids ? [...ids] : null, limit],
    );
    if (rows.length > 0) {
      await query(
        `UPDATE tax_invoice_submissions SET leased_until = $2::timestamptz + make_interval(secs => $3::int)
          WHERE id = ANY($1::uuid[])`,
        [rows.map((row) => row.id), now, Math.round(INQUIRY_LEASE_MS / 1000)],
      );
    }
    return rows;
  });
}

async function inquireOne(businessId: string, claim: InquiryClaim, credentials: TaxCredentials | null, now: Date): Promise<void> {
  const adapter = providerFor(claim.environment);
  let outcome: InquiryOutcome;
  try {
    outcome = await adapter.inquire({
      uid: claim.uid,
      reference: claim.reference_number,
      receiptId: claim.receipt_id,
      environment: claim.environment,
      credentials,
    });
  } catch (error) {
    outcome = { state: "unreachable", code: "inquiry_error", message: error instanceof Error ? error.message : "استعلام انجام نشد." };
  }

  const decision = decideAfterInquiry(claim.status, outcome, claim.attempts, now);
  await withTenantTransaction(businessId, async () => {
    const updated = await query<{ id: string }>(
      `UPDATE tax_invoice_submissions
          SET status = $2::text,
              receipt_id = COALESCE(receipt_id, $3::text),
              inquiry_result = $4::jsonb,
              last_inquired_at = $5::timestamptz,
              next_attempt_at = $6::timestamptz,
              leased_until = NULL,
              last_error_code = $7::text,
              last_error_message = $8::text,
              provider_errors = $9::jsonb,
              accepted_at = CASE WHEN $2::text = 'accepted' THEN now() ELSE accepted_at END,
              updated_at = now()
        WHERE id = $1 AND status = $10::text
      RETURNING id`,
      [
        claim.id,
        decision.to,
        decision.receiptId,
        JSON.stringify({ state: outcome.state, at: now.toISOString() }),
        now,
        decision.nextAttemptAt,
        decision.errorCode,
        decision.errorMessage,
        JSON.stringify(decision.providerErrors),
        claim.status,
      ],
    );
    if (updated.rowCount === 0) {
      // A concurrent move already changed this record. Its own history says what happened.
      return;
    }
    await recordEvent(businessId, claim.id, {
      type: "inquired",
      from: claim.status,
      to: decision.to,
      correlationId: claim.correlation_id,
      detail: { state: outcome.state, code: decision.errorCode },
    });
    if (decision.to === "accepted" && claim.kind === "cancellation" && claim.parent_submission_id) {
      const parent = await query<{ id: string; status: TaxStatus; correlation_id: string }>(
        `UPDATE tax_invoice_submissions SET status = 'cancelled', updated_at = now()
          WHERE id = $1 AND status = 'accepted'
        RETURNING id, status, correlation_id`,
        [claim.parent_submission_id],
      );
      if (parent.rows[0]) {
        await recordEvent(businessId, parent.rows[0].id, {
          type: "cancelled",
          from: "accepted",
          to: "cancelled",
          correlationId: claim.correlation_id,
          detail: { byCancellation: claim.id },
        });
      }
    }
    if (decision.to === "queued") {
      await recordEvent(businessId, claim.id, {
        type: "not_received",
        from: claim.status,
        to: "queued",
        correlationId: claim.correlation_id,
        detail: { note: "the authority holds no packet under this uid; a resend reuses it" },
      });
    }
  });
  taxLog("record.inquired", { correlationId: claim.correlation_id, submissionId: claim.id, state: outcome.state, to: decision.to });
}

export async function inquireSubmissions(
  businessId: string,
  options: { ids?: readonly string[]; force: boolean; now?: Date; limit?: number },
): Promise<{ inquired: number }> {
  const now = options.now ?? new Date();
  const limit = Math.min(options.limit ?? MAX_BATCH, MAX_BATCH);
  const credentials = await withTenant(businessId, async () => {
    const { rows } = await query<{ credentials_ciphertext: string | null }>(
      `SELECT credentials_ciphertext FROM tax_invoice_profiles WHERE business_id = $1`,
      [businessId],
    );
    return openCredentials(rows[0]?.credentials_ciphertext ?? null);
  });
  const claims = await claimForInquiry(businessId, options.ids ?? null, now, limit, options.force);
  for (const claim of claims) await inquireOne(businessId, claim, credentials, now);
  return { inquired: claims.length };
}

// ---------------------------------------------------------------------------
// Operator actions on a record
// ---------------------------------------------------------------------------

/** `error` → `queued`: an operator asked for another attempt. The same uid is reused. */
export async function retrySubmission(actor: TaxActor, id: string): Promise<TaxStatus | null> {
  requireUuid(id);
  const moved = await withTenantTransaction(actor.businessId, async () => {
    const record = await loadRecord(id, true);
    if (!record) throw new TaxServiceError("not_found", 404, "صورتحساب پیدا نشد.");
    if (record.status !== "error") throw new TaxServiceError("not_retryable", 409, "فقط خطا را می‌توان دوباره ارسال کرد.");
    await query(
      `UPDATE tax_invoice_submissions
          SET status = 'queued', next_attempt_at = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = now()
        WHERE id = $1 AND status = 'error'`,
      [id],
    );
    await recordEvent(actor.businessId, id, {
      type: "retry_requested",
      from: "error",
      to: "queued",
      actorUserId: actor.userId,
      correlationId: record.correlation_id,
    });
    return record;
  });
  await drainSubmissions(actor.businessId, { ids: [moved.id], limit: 1 });
  return (await withTenant(actor.businessId, () => loadRecord(id)))?.status ?? null;
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 3 || trimmed.length > 500) {
    throw new TaxServiceError("reason_required", 400, "دلیل اصلاح یا ابطال را بین ۳ تا ۵۰۰ نویسه وارد کنید.");
  }
  return trimmed;
}

/** `accepted` → a new prepared amendment, built from the sale as it stands now. */
export async function amendSubmission(actor: TaxActor, id: string, reason: string): Promise<PrepareResult> {
  requireUuid(id);
  const text = requireReason(reason);
  return withTenantTransaction(actor.businessId, async () => {
    const parent = await loadRecord(id, true);
    if (!parent) throw new TaxServiceError("not_found", 404, "صورتحساب پیدا نشد.");
    if (parent.status !== "accepted") throw new TaxServiceError("not_accepted", 409, "فقط صورتحساب پذیرفته‌شده را می‌توان اصلاح کرد.");
    if (parent.kind === "cancellation") throw new TaxServiceError("not_amendable", 409, "ابطال را نمی‌توان اصلاح کرد.");
    const correlationId = randomUUID();
    const outcome = await createRecord(actor, { orderId: parent.order_id, kind: "amendment", parent, reason: text, correlationId });
    return toPrepareResult(parent.order_id, outcome);
  });
}

/** `accepted` sale → a new prepared cancellation that reproduces the withdrawn invoice. */
export async function cancelSubmission(actor: TaxActor, id: string, reason: string): Promise<PrepareResult> {
  requireUuid(id);
  const text = requireReason(reason);
  return withTenantTransaction(actor.businessId, async () => {
    const parent = await loadRecord(id, true);
    if (!parent) throw new TaxServiceError("not_found", 404, "صورتحساب پیدا نشد.");
    if (parent.status !== "accepted") throw new TaxServiceError("not_accepted", 409, "فقط صورتحساب پذیرفته‌شده را می‌توان ابطال کرد.");
    if (parent.kind !== "sale") throw new TaxServiceError("not_cancellable", 409, "فقط صدور اصلی را می‌توان ابطال کرد.");
    const correlationId = randomUUID();
    const outcome = await createRecord(actor, { orderId: parent.order_id, kind: "cancellation", parent, reason: text, correlationId });
    return toPrepareResult(parent.order_id, outcome);
  });
}

/** `rejected` → a new prepared revision of the same kind, built from the current source. */
export async function resubmitSubmission(actor: TaxActor, id: string): Promise<PrepareResult> {
  requireUuid(id);
  return withTenantTransaction(actor.businessId, async () => {
    const rejected = await loadRecord(id, true);
    if (!rejected) throw new TaxServiceError("not_found", 404, "صورتحساب پیدا نشد.");
    if (rejected.status !== "rejected") throw new TaxServiceError("not_rejected", 409, "فقط صورتحساب ردشده را می‌توان دوباره صادر کرد.");
    let parent: TaxRecordRow | null = null;
    if (rejected.parent_submission_id) {
      parent = await loadRecord(rejected.parent_submission_id, true);
      if (!parent || parent.status !== "accepted") {
        throw new TaxServiceError("parent_not_accepted", 409, "صورتحساب اصلی هنوز پذیرفته‌شده نیست.");
      }
    }
    const correlationId = randomUUID();
    const outcome = await createRecord(actor, {
      orderId: rejected.order_id,
      kind: rejected.kind,
      parent,
      reason: rejected.kind === "sale" ? null : rejected.payload_snapshot.reason,
      correlationId,
    });
    return toPrepareResult(rejected.order_id, outcome);
  });
}

function toPrepareResult(orderId: string, outcome: CreateOutcome): PrepareResult {
  if (outcome.outcome === "blocked") {
    return { orderId, outcome: "blocked", submissionId: null, reference: null, blockers: outcome.blockers, error: null };
  }
  return {
    orderId,
    outcome: outcome.outcome === "created" ? "prepared" : "existing",
    submissionId: outcome.record.id,
    reference: outcome.record.reference_number,
    blockers: [],
    error: null,
  };
}

/**
 * The worker's tick. Enumerates the businesses with work waiting (a platform
 * read, the same shape as the other integration ticks), then runs each one's
 * lease recovery, sends and inquiries inside that business's tenant scope.
 */
export async function runTaxInvoiceTick(now = new Date()): Promise<{ businesses: number; submitted: number; inquired: number }> {
  const due = await withoutTenantScope("platform", () =>
    query<{ business_id: string }>(
      `SELECT DISTINCT business_id FROM tax_invoice_submissions
        WHERE (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= $1))
           OR (status = 'sending' AND leased_until < $1)
           OR (status IN ('submitted', 'awaiting_inquiry') AND (next_attempt_at IS NULL OR next_attempt_at <= $1))`,
      [now],
    ),
  );
  let submitted = 0;
  let inquired = 0;
  for (const { business_id: businessId } of due.rows) {
    try {
      await recoverExpiredSendLeases(businessId, now);
      const sent = await drainSubmissions(businessId, { now });
      submitted += sent.submitted;
      const checked = await inquireSubmissions(businessId, { force: false, now });
      inquired += checked.inquired;
    } catch (error) {
      taxLog("tick.business_failed", { businessId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { businesses: due.rows.length, submitted, inquired };
}
