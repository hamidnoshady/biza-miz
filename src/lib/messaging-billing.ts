/**
 * Phase 37 Wave 1 — database operations for platform-owned message config and
 * metered SMS/email credits.
 *
 * Mirrors what Phase 18's AI platform billing did (the since-removed
 * src/lib/ai-billing-service.ts, retired in Phase J): the platform holds the
 * provider relationship, the business never pastes a key, and every balance is
 * the SUM of a signed ledger — never a writable column.
 *
 * Three ownership rules govern the SQL:
 *   * Platform-wide configuration is a `platform_*` singleton administered in
 *     the console under `withoutTenantScope("platform", …)` — no tenant column.
 *   * A business's own balance/history/top-up is read and written in the
 *     current tenant scope, or under `withoutTenantScope` when the console is
 *     administering a *named* business across tenants.
 *   * The reservation contract (max-reserve → settle/refund) is the atomic one
 *     the retired `ai-billing-service.ts` used, so two ticks cannot spend the
 *     same credit.
 */
import { randomUUID } from "node:crypto";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getPool, query, withTenant, withoutTenantScope, type PoolClient } from "./db";
import { chargeFeatureUse, postWalletEntryTx, WalletInsufficientFundsError } from "./wallet-service";
import { getRealmSecret } from "./jwt-secret";
import type { CampaignChannel } from "./campaign-channels";
import type { MessageRate } from "./messaging-billing-pure";

export type MessageLedgerKind = "manual_grant" | "top_up" | "usage" | "usage_refund";

export type MessageTopUpStatus = "pending" | "approved" | "rejected";

export interface MessageResolvedConfig {
  enabled: boolean;
  smsProvider: "kavenegar" | "noop";
  emailProvider: "smtp" | "noop";
  kavenegarApiKey: string | null;
  kavenegarSender: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string | null;
    from: string;
  } | null;
  rate: MessageRate;
  smtpConfigured: boolean;
  kavenegarConfigured: boolean;
  configured: boolean;
}

export interface MessagePublicConfig {
  enabled: boolean;
  smsProvider: "kavenegar" | "noop";
  emailProvider: "smtp" | "noop";
  /** Whether each provider has usable credentials (never the credentials). */
  kavenegarConfigured: boolean;
  smtpConfigured: boolean;
  kavenegarSender: string;
  kavenegarKeyHint: string | null;
  smtpHost: string;
  smtpFrom: string;
  rate: MessageRate;
  configured: boolean;
  updatedAt: string | null;
}

export interface MessageSaveConfigInput {
  enabled?: boolean;
  smsProvider?: "kavenegar" | "noop";
  emailProvider?: "smtp" | "noop";
  kavenegarApiKey?: string | null;
  kavenegarSender?: string;
  clearKavenegarKey?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPassword?: string | null;
  smtpFrom?: string;
  clearSmtpPassword?: boolean;
  smsRialPerSegment?: number;
  emailRialPerSend?: number;
}

export interface MessageBusinessBilling {
  /** Always reconstructed from the signed ledger; never a cached balance. */
  balanceRial: number;
}

export interface MessageCreditPackage {
  id: string;
  name: string;
  priceRial: number;
  creditAmountRial: number;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface MessageLedgerEntry {
  id: string;
  kind: MessageLedgerKind;
  amountRial: number;
  actualCostRial: number | null;
  note: string | null;
  createdAt: string;
}

export interface MessageTopUpRequest {
  id: string;
  businessId: string;
  businessName: string | null;
  packageId: string | null;
  packageName: string;
  priceRial: number;
  creditAmountRial: number;
  note: string | null;
  status: MessageTopUpStatus;
  reviewedAt: string | null;
  createdAt: string;
}

export interface MessageSendReservation {
  requestId: string;
  reservedRial: number;
}

export class MessageInsufficientCreditError extends Error {
  constructor() {
    super("message_credit_required");
  }
}

export class MessageTopUpStateError extends Error {
  constructor() {
    super("top_up_not_pending");
  }
}

export class MessageConfigError extends Error {
  constructor(message = "message_provider_not_configured") {
    super(message);
  }
}

function numberValue(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function nonNegativeInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// Credential encryption (AES-256-GCM with the platform realm secret) — the
// same envelope as platform_sms_config.
// ---------------------------------------------------------------------------

function encryptCredential(plain: string, key: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decryptCredential(data: Buffer, key: Uint8Array): string | null {
  try {
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Platform message configuration
// ---------------------------------------------------------------------------

type ConfigRow = {
  enabled: boolean;
  sms_provider: string;
  email_provider: string;
  kavenegar_api_key_enc: Buffer | null;
  kavenegar_sender: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_password_enc: Buffer | null;
  smtp_from: string;
  sms_rial_per_segment: string | number;
  email_rial_per_send: string | number;
  updated_at: string | Date | null;
};

export async function resolveMessageConfig(): Promise<MessageResolvedConfig> {
  const row = await withoutTenantScope("platform", async () => {
    const { rows } = await query<ConfigRow>(
      `SELECT enabled, sms_provider, email_provider, kavenegar_api_key_enc,
              kavenegar_sender, smtp_host, smtp_port, smtp_secure, smtp_user,
              smtp_password_enc, smtp_from, sms_rial_per_segment,
              email_rial_per_send, updated_at
         FROM platform_message_config WHERE id = true`,
    );
    return rows[0];
  });

  const key = await getRealmSecret("platform");
  const base: Omit<MessageResolvedConfig, "configured"> = {
    enabled: row?.enabled ?? false,
    smsProvider: row?.sms_provider === "kavenegar" ? "kavenegar" : "noop",
    emailProvider: row?.email_provider === "smtp" ? "smtp" : "noop",
    kavenegarApiKey: row?.kavenegar_api_key_enc
      ? decryptCredential(row.kavenegar_api_key_enc, key)
      : null,
    kavenegarSender: row?.kavenegar_sender ?? "",
    smtp:
      row && (row.smtp_host || row.smtp_user || row.smtp_from)
        ? {
            host: row.smtp_host,
            port: row.smtp_port,
            secure: row.smtp_secure,
            user: row.smtp_user,
            password: row.smtp_password_enc
              ? decryptCredential(row.smtp_password_enc, key)
              : null,
            from: row.smtp_from,
          }
        : null,
    rate: {
      smsRialPerSegment: numberValue(row?.sms_rial_per_segment),
      emailRialPerSend: numberValue(row?.email_rial_per_send),
    },
    smtpConfigured: Boolean(
      row && row.smtp_host && row.smtp_from && (row.smtp_user || true) && row.smtp_password_enc,
    ),
    kavenegarConfigured: Boolean(row?.kavenegar_api_key_enc),
  };
  return {
    ...base,
    configured:
      base.enabled &&
      ((base.smsProvider === "noop" || base.kavenegarConfigured) &&
        (base.emailProvider === "noop" || base.smtpConfigured)),
  };
}

/** The effective provider credentials for sending, or throws when unusable. */
export async function requireMessageProviders(): Promise<MessageResolvedConfig> {
  const config = await resolveMessageConfig();
  if (!config.enabled) throw new MessageConfigError("message_disabled");
  if (config.smsProvider === "kavenegar" && !config.kavenegarApiKey) {
    throw new MessageConfigError("message_kavenegar_not_configured");
  }
  if (config.emailProvider === "smtp" && !config.smtpConfigured) {
    throw new MessageConfigError("message_smtp_not_configured");
  }
  return config;
}

export async function getPublicMessageConfig(): Promise<MessagePublicConfig> {
  const config = await resolveMessageConfig();
  const key = await getRealmSecret("platform");
  const kavenegarKey = config.kavenegarApiKey;
  return {
    enabled: config.enabled,
    smsProvider: config.smsProvider,
    emailProvider: config.emailProvider,
    kavenegarConfigured: config.kavenegarConfigured,
    smtpConfigured: config.smtpConfigured,
    kavenegarSender: config.kavenegarSender,
    kavenegarKeyHint: kavenegarKey ? `••••${kavenegarKey.slice(-4)}` : null,
    smtpHost: config.smtp?.host ?? "",
    smtpFrom: config.smtp?.from ?? "",
    rate: config.rate,
    configured: config.configured,
    updatedAt: null,
  };
}

export async function savePlatformMessageConfig(
  input: MessageSaveConfigInput,
): Promise<MessagePublicConfig> {
  const key = await getRealmSecret("platform");
  await withoutTenantScope("platform", async () => {
    const { rows } = await query<ConfigRow>(
      `SELECT enabled, sms_provider, email_provider, kavenegar_api_key_enc,
              kavenegar_sender, smtp_host, smtp_port, smtp_secure, smtp_user,
              smtp_password_enc, smtp_from, sms_rial_per_segment,
              email_rial_per_send, updated_at
         FROM platform_message_config WHERE id = true`,
    );
    const current = rows[0];
    const kavenegarKey =
      input.clearKavenegarKey === true
        ? null
        : typeof input.kavenegarApiKey === "string" && input.kavenegarApiKey.trim().length > 0
          ? encryptCredential(input.kavenegarApiKey.trim(), key)
          : current?.kavenegar_api_key_enc ?? null;
    const smtpPassword =
      input.clearSmtpPassword === true
        ? null
        : typeof input.smtpPassword === "string" && input.smtpPassword.trim().length > 0
          ? encryptCredential(input.smtpPassword.trim(), key)
          : current?.smtp_password_enc ?? null;

    if (!current) {
      await query(
        `INSERT INTO platform_message_config
           (id, enabled, sms_provider, email_provider, kavenegar_api_key_enc,
            kavenegar_sender, smtp_host, smtp_port, smtp_secure, smtp_user,
            smtp_password_enc, smtp_from, sms_rial_per_segment,
            email_rial_per_send, updated_at)
         VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())`,
        [
          input.enabled ?? false,
          input.smsProvider ?? "kavenegar",
          input.emailProvider ?? "smtp",
          kavenegarKey,
          input.kavenegarSender ?? "",
          input.smtpHost ?? "",
          input.smtpPort ?? 587,
          input.smtpSecure ?? false,
          input.smtpUser ?? "",
          smtpPassword,
          input.smtpFrom ?? "",
          input.smsRialPerSegment ?? 0,
          input.emailRialPerSend ?? 0,
        ],
      );
      return;
    }
    await query(
      `UPDATE platform_message_config
          SET enabled = $1, sms_provider = $2, email_provider = $3,
              kavenegar_api_key_enc = $4, kavenegar_sender = $5,
              smtp_host = $6, smtp_port = $7, smtp_secure = $8, smtp_user = $9,
              smtp_password_enc = $10, smtp_from = $11,
              sms_rial_per_segment = $12, email_rial_per_send = $13,
              updated_at = now()
        WHERE id = true`,
      [
        input.enabled ?? current.enabled,
        input.smsProvider ?? current.sms_provider,
        input.emailProvider ?? current.email_provider,
        kavenegarKey,
        input.kavenegarSender ?? current.kavenegar_sender,
        input.smtpHost ?? current.smtp_host,
        input.smtpPort ?? current.smtp_port,
        input.smtpSecure ?? current.smtp_secure,
        input.smtpUser ?? current.smtp_user,
        smtpPassword,
        input.smtpFrom ?? current.smtp_from,
        input.smsRialPerSegment ?? current.sms_rial_per_segment,
        input.emailRialPerSend ?? current.email_rial_per_send,
      ],
    );
  });
  return getPublicMessageConfig();
}

/**
 * Save ONLY the metered rates (Rial per SMS segment / per email) — the
 * Billing rates console's write path (migration 0176 moved commercial rate
 * ownership from /platform/messaging to /platform/billing). Providers,
 * credentials and sending config stay in savePlatformMessageConfig.
 */
export async function saveMessageRates(input: {
  smsRialPerSegment?: number;
  emailRialPerSend?: number;
  adminId?: string | null;
}): Promise<{ smsRialPerSegment: number; emailRialPerSend: number }> {
  const parse = (value: number | undefined) =>
    value === undefined ? undefined : Number.isSafeInteger(value) && value >= 0 ? value : NaN;
  const sms = parse(input.smsRialPerSegment);
  const email = parse(input.emailRialPerSend);
  if (Number.isNaN(sms) || Number.isNaN(email)) {
    throw new MessageConfigError("invalid_rate");
  }
  await withoutTenantScope("platform", async () => {
    const { rows } = await query<{ sms: string; email: string }>(
      `SELECT sms_rial_per_segment AS sms, email_rial_per_send AS email
         FROM platform_message_config WHERE id = true`,
    );
    const current = rows[0];
    const nextSms = sms ?? Number(current?.sms ?? 0);
    const nextEmail = email ?? Number(current?.email ?? 0);
    await query(
      `INSERT INTO platform_message_config (id, sms_rial_per_segment, email_rial_per_send)
       VALUES (true, $1, $2)
       ON CONFLICT (id) DO UPDATE SET
         sms_rial_per_segment = EXCLUDED.sms_rial_per_segment,
         email_rial_per_send = EXCLUDED.email_rial_per_send,
         updated_at = now()`,
      [nextSms, nextEmail],
    );
    const { publishPriceVersion } = await import("./billing/runtime");
    if (sms !== undefined) {
      await publishPriceVersion({
        targetType: "meter",
        targetKey: "messaging.sms_segment",
        unit: "segment",
        unitAmountRial: nextSms,
        unitSize: 1,
        createdBy: input.adminId ?? null,
      });
    }
    if (email !== undefined) {
      await publishPriceVersion({
        targetType: "meter",
        targetKey: "messaging.email_send",
        unit: "send",
        unitAmountRial: nextEmail,
        unitSize: 1,
        createdBy: input.adminId ?? null,
      });
    }
  });
  const config = await resolveMessageConfig();
  return config.rate;
}

// ---------------------------------------------------------------------------
// Business billing, history and top-ups
// ---------------------------------------------------------------------------

/**
 * The balance deliberately has no cache column.  A signed ledger is the source
 * of truth, so restoring a backup or retrying a settlement cannot make a
 * business appear richer or poorer than its transaction history says.
 */
export async function getMessageBusinessBilling(businessId: string): Promise<MessageBusinessBilling> {
  return { balanceRial: await getMessageLedgerBalance(businessId) };
}

function toCreditPackage(row: {
  id: string;
  name: string;
  price_rial: string | number;
  credit_amount_rial: string | number;
  is_active: boolean;
  sort_order: number;
  created_at: string;
}): MessageCreditPackage {
  return {
    id: row.id,
    name: row.name,
    priceRial: numberValue(row.price_rial),
    creditAmountRial: numberValue(row.credit_amount_rial),
    isActive: row.is_active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

/** The owner only sees packages that the platform currently offers. */
export async function listMessageCreditPackages(activeOnly = false): Promise<MessageCreditPackage[]> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      id: string;
      name: string;
      price_rial: string | number;
      credit_amount_rial: string | number;
      is_active: boolean;
      sort_order: number;
      created_at: string;
    }>(
      `SELECT id, name, price_rial, credit_amount_rial, is_active, sort_order, created_at
         FROM message_credit_packages
        WHERE ($1::boolean = false OR is_active)
        ORDER BY sort_order, created_at, id`,
      [activeOnly],
    );
    return rows.map(toCreditPackage);
  });
}

/** Platform-console package upsert. Amounts are integer Rial by contract. */
export async function saveMessageCreditPackage(input: {
  id?: string;
  name: string;
  priceRial: number;
  creditAmountRial: number;
  isActive?: boolean;
  sortOrder?: number;
}): Promise<MessageCreditPackage> {
  const name = input.name.trim();
  if (!name || !nonNegativeInt(input.priceRial) || input.priceRial <= 0 || !nonNegativeInt(input.creditAmountRial) || input.creditAmountRial <= 0) {
    throw new Error("invalid_message_credit_package");
  }
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{
      id: string;
      name: string;
      price_rial: string | number;
      credit_amount_rial: string | number;
      is_active: boolean;
      sort_order: number;
      created_at: string;
    }>(
      input.id
        ? `UPDATE message_credit_packages
              SET name = $2, price_rial = $3, credit_amount_rial = $4,
                  is_active = $5, sort_order = $6, updated_at = now()
            WHERE id = $1
            RETURNING id, name, price_rial, credit_amount_rial, is_active, sort_order, created_at`
        : `INSERT INTO message_credit_packages
              (name, price_rial, credit_amount_rial, is_active, sort_order)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, price_rial, credit_amount_rial, is_active, sort_order, created_at`,
      input.id
        ? [input.id, name, input.priceRial, input.creditAmountRial, input.isActive !== false, Math.trunc(input.sortOrder ?? 0)]
        : [name, input.priceRial, input.creditAmountRial, input.isActive !== false, Math.trunc(input.sortOrder ?? 0)],
    );
    if (!rows[0]) throw new Error("message_credit_package_not_found");
    return toCreditPackage(rows[0]);
  });
}

// Issue #764: the tenant-side message-credit purchase (package list, top-up
// request, the legacy credit statement) is gone from Growth — credit is bought
// in the central wallet at /settings/billing. `message_top_up_requests` and
// `message_credit_ledger` stay: the platform console still reviews requests
// filed before the change, and the ledger is pre-0177 history.

type MessageTopUpRequestRow = {
  id: string;
  business_id: string;
  package_id: string | null;
  package_name: string;
  price_rial: string;
  credit_amount_rial: string;
  note: string | null;
  status: MessageTopUpStatus;
  reviewed_at: string | null;
  created_at: string;
};

function toTopUpRequest(row: MessageTopUpRequestRow, businessName: string | null): MessageTopUpRequest {
  return {
    id: row.id,
    businessId: row.business_id,
    businessName,
    packageId: row.package_id,
    packageName: row.package_name,
    priceRial: numberValue(row.price_rial),
    creditAmountRial: numberValue(row.credit_amount_rial),
    note: row.note,
    status: row.status,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

export async function reviewMessageTopUpRequest(input: {
  requestId: string;
  status: "approved" | "rejected";
  platformAdminId: string;
}): Promise<MessageTopUpRequest> {
  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows: requestRows } = await client.query<MessageTopUpRequestRow>(
        `SELECT id, business_id, package_id, package_name, price_rial,
                credit_amount_rial, note, status, reviewed_at, created_at
           FROM message_top_up_requests
          WHERE id = $1 FOR UPDATE`,
        [input.requestId],
      );
      const request = requestRows[0];
      if (!request) throw new Error("not_found");
      if (request.status !== "pending") throw new MessageTopUpStateError();

      let ledgerId: string | null = null;
      if (input.status === "approved") {
        ledgerId = await grantMessageCreditInTransaction(client, {
          businessId: request.business_id,
          amountRial: numberValue(request.credit_amount_rial),
          kind: "top_up",
          note: `تأیید شارژ «${request.package_name}»`,
          platformAdminId: input.platformAdminId,
        });
      }
      const { rows: updated } = await client.query<MessageTopUpRequestRow>(
        `UPDATE message_top_up_requests
            SET status = $2, reviewed_by = $3, reviewed_at = now(), fulfilled_ledger_id = $4
          WHERE id = $1
          RETURNING id, business_id, package_id, package_name, price_rial,
                    credit_amount_rial, note, status, reviewed_at, created_at`,
        [input.requestId, input.status, input.platformAdminId, ledgerId],
      );
      await client.query("COMMIT");
      return toTopUpRequest(updated[0], null);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function listPlatformMessageTopUpRequests(
  pendingOnly = false,
): Promise<MessageTopUpRequest[]> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<MessageTopUpRequestRow & { business_name: string }>(
      `SELECT r.id, r.business_id, b.name AS business_name, r.package_id, r.package_name,
              r.price_rial, r.credit_amount_rial, r.note, r.status, r.reviewed_at, r.created_at
         FROM message_top_up_requests r
         JOIN businesses b ON b.id = r.business_id
        WHERE ($1::boolean = false OR r.status = 'pending')
        ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC
        LIMIT 200`,
      [pendingOnly],
    );
    return rows.map((r) => toTopUpRequest(r, r.business_name));
  });
}

async function grantMessageCreditInTransaction(
  client: PoolClient,
  input: {
    businessId: string;
    amountRial: number;
    kind: MessageLedgerKind;
    note: string | null;
    createdByUserId?: string | null;
    platformAdminId?: string | null;
  },
): Promise<string | null> {
  // New credits land in the platform wallet. message_credit_ledger stays as
  // history from before migration 0177 and is not written here.
  if (input.amountRial <= 0) return null;
  await postWalletEntryTx(client, {
    businessId: input.businessId,
    kind: input.kind === "top_up" ? "top_up" : "admin_grant",
    direction: "credit",
    amountRial: input.amountRial,
    featureKey: "messaging",
    note: input.note,
    userId: input.createdByUserId ?? null,
    platformAdminId: input.platformAdminId ?? null,
    metadata: { source: "message_credit", legacyKind: input.kind },
  });
  return null;
}

/** Serialises a business's balance-changing ledger transaction without a mutable balance row. */
async function lockMessageCreditLedger(client: PoolClient, businessId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 7310318183545164275))`, [businessId]);
}

async function messageLedgerBalanceInTransaction(client: PoolClient, businessId: string): Promise<number> {
  const { rows } = await client.query<{ balance_rial: string | null }>(
    `SELECT coalesce(sum(amount_rial), 0)::text AS balance_rial
       FROM message_credit_ledger WHERE business_id = $1`,
    [businessId],
  );
  return numberValue(rows[0]?.balance_rial);
}

// ---------------------------------------------------------------------------
// Reserve → settle → refund. The atomic contract, identical to ai-billing.
// ---------------------------------------------------------------------------

/**
 * Reserves `reservedRial` up-front. Throws MessageInsufficientCreditError when
 * the business cannot cover it, before any send attempt (Wave 1 exit #5).
 */
export async function reserveMessageSend(input: {
  businessId: string;
  reservedRial: number;
  userId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<MessageSendReservation> {
  if (!Number.isSafeInteger(input.reservedRial) || input.reservedRial <= 0) {
    throw new MessageInsufficientCreditError();
  }
  const requestId = randomUUID();
  try {
    await chargeFeatureUse({
      businessId: input.businessId,
      featureKey: "messaging",
      priceRial: input.reservedRial,
      note: "رزرو ارسال پیام",
      userId: input.userId ?? null,
      metadata: {
        ...input.metadata,
        messageRequestId: requestId,
        phase: "reserved",
        reservedRial: input.reservedRial,
      },
    });
    return { requestId, reservedRial: input.reservedRial };
  } catch (error) {
    if (error instanceof WalletInsufficientFundsError) throw new MessageInsufficientCreditError();
    throw error;
  }
}

/**
 * Settles a reservation against the cost that actually went out (Wave 4's
 * "cost at real-send time, per what actually went"). Returns the refunded
 * remainder so the caller can post exactly what was spent.
 */
export async function settleMessageSend(input: {
  businessId: string;
  reservation: MessageSendReservation;
  actualCostRial: number;
  note?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ chargedRial: number; refundedRial: number }> {
  const chargedRial = Math.max(0, Math.min(input.actualCostRial, input.reservation.reservedRial));
  const refundedRial = input.reservation.reservedRial - chargedRial;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ phase: string; charged: string | null; refunded: string | null }>(
      `SELECT metadata->>'phase' AS phase,
              metadata->>'chargedRial' AS charged,
              metadata->>'refundedRial' AS refunded
         FROM wallet_ledger
        WHERE business_id = $1 AND metadata->>'messageRequestId' = $2
        ORDER BY created_at
        FOR UPDATE`,
      [input.businessId, input.reservation.requestId],
    );
    const settled = rows.find((row) => row.phase === "settled" || row.phase === "refunded");
    if (settled) {
      await client.query("COMMIT");
      return {
        chargedRial: Number(settled.charged ?? chargedRial),
        refundedRial: Number(settled.refunded ?? 0),
      };
    }
    if (!rows.some((row) => row.phase === "reserved")) throw new Error("message_reservation_not_found");
    if (refundedRial > 0) {
      await postWalletEntryTx(client, {
        businessId: input.businessId,
        kind: "refund",
        direction: "credit",
        amountRial: refundedRial,
        featureKey: "messaging",
        note: input.note ?? "بازگشت مازاد رزرو پیام",
        metadata: {
          reversesSpend: true,
          messageRequestId: input.reservation.requestId,
          phase: "settled",
          chargedRial,
          refundedRial,
          ...input.metadata,
        },
      });
      await client.query(
        `UPDATE feature_usage
            SET spent_rial = GREATEST(0, spent_rial - $2),
                charged_count = CASE WHEN $3 = 0 THEN GREATEST(0, charged_count - 1) ELSE charged_count END,
                updated_at = now()
          WHERE business_id = $1 AND feature_key = 'messaging'`,
        [input.businessId, refundedRial, chargedRial],
      );
    }
    await client.query(
      `UPDATE wallet_ledger
          SET metadata = metadata || $3::jsonb
        WHERE business_id = $1 AND metadata->>'messageRequestId' = $2
          AND metadata->>'phase' = 'reserved'`,
      [
        input.businessId,
        input.reservation.requestId,
        JSON.stringify({ phase: "settled", chargedRial, refundedRial }),
      ],
    );
    await client.query("COMMIT");
    return { chargedRial, refundedRial };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Refunds an untouched reservation in full — used when a send never happened
 * (a provider outage or a campaign paused before it went out). Exactly the
 * "unsent messages return their credit" path of Wave 2 exit #6.
 */
export async function refundUnsentMessage(input: {
  businessId: string;
  reservation: MessageSendReservation;
  reason: string;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ phase: string }>(
      `SELECT metadata->>'phase' AS phase FROM wallet_ledger
        WHERE business_id = $1 AND metadata->>'messageRequestId' = $2
        FOR UPDATE`,
      [input.businessId, input.reservation.requestId],
    );
    if (rows.some((row) => row.phase === "reserved") && !rows.some((row) => row.phase === "refunded" || row.phase === "settled")) {
      await postWalletEntryTx(client, {
        businessId: input.businessId,
        kind: "refund",
        direction: "credit",
        amountRial: input.reservation.reservedRial,
        featureKey: "messaging",
        note: input.reason,
        metadata: {
          reversesSpend: true,
          messageRequestId: input.reservation.requestId,
          phase: "refunded",
          chargedRial: 0,
          refundedRial: input.reservation.reservedRial,
          reason: input.reason,
        },
      });
      await client.query(
        `UPDATE feature_usage
            SET spent_rial = GREATEST(0, spent_rial - $2),
                charged_count = GREATEST(0, charged_count - 1),
                used_count = GREATEST(0, used_count - 1),
                updated_at = now()
          WHERE business_id = $1 AND feature_key = 'messaging'`,
        [input.businessId, input.reservation.reservedRial],
      );
      await client.query(
        `UPDATE wallet_ledger
            SET metadata = metadata || '{"phase":"refunded"}'::jsonb
          WHERE business_id = $1 AND metadata->>'messageRequestId' = $2
            AND metadata->>'phase' = 'reserved'`,
        [input.businessId, input.reservation.requestId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Convenience: settle a reservation at a channel's exact rendered cost. */
export async function settleMessageAtCost(input: {
  businessId: string;
  reservation: MessageSendReservation;
  channel: CampaignChannel;
  body: string;
  rate: MessageRate;
  note?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ chargedRial: number; refundedRial: number }> {
  // Imported lazily to avoid a cycle at module load (both are cheap pure fns).
  const { messageCostRial } = await import("./messaging-billing-pure");
  return settleMessageSend({
    businessId: input.businessId,
    reservation: input.reservation,
    actualCostRial: messageCostRial(input.channel, input.body, input.rate),
    note: input.note,
    metadata: input.metadata,
  });
}

/**
 * Background tick used by Wave 1 exit #4's guarantee that a balance is always
 * a ledger SUM. Reads each business's true balance directly from the ledger so
 * a drift between the mirrored column and the SUM cannot hide forever.
 */
export async function getMessageLedgerBalance(businessId: string): Promise<number> {
  const { rows } = await query<{ balance_rial: string | null }>(
    `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
    [businessId],
  );
  return numberValue(rows[0]?.balance_rial);
}

/** per-business helper used by the outbox tick to settle a whole campaign. */
export async function withTenantMessageBalance<T>(
  businessId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withTenant(businessId, fn);
}
