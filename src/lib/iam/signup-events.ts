/**
 * Issue #1388 — signup/onboarding funnel events and safe account inspection.
 *
 * The ledger is deliberately facts-only: a stable event name, a closed failure
 * category, and ids. There is no column for a phone, email, name, code, token,
 * request token hash, password, national ID or provider payload. That is what
 * makes the console's aggregate reads safe by construction rather than by
 * review, and it means the funnel cannot become a second OTP store.
 *
 * Every write is best-effort: a signup must not fail because telemetry did.
 * Reads are platform-only.
 */
import { query, withoutTenantScope } from "../db";
import { getTenantScope } from "../tenant-context";
import { maskPhoneE164 } from "../phone-otp";
import { getPublicSmsConfig } from "../sms-config";
import { getServiceAlertSummary, listServiceAlerts } from "../kavenegar/alert-service";

/** The one stable vocabulary both the writer and the console share. */
export const SIGNUP_EVENT_NAMES = [
  "otp_requested",
  "otp_sent",
  "otp_failed",
  "otp_verified",
  "account_created",
  "onboarding_started",
  "onboarding_completed",
  "business_provisioned",
] as const;

export type SignupEventName = (typeof SIGNUP_EVENT_NAMES)[number];

export const SIGNUP_FAILURE_CATEGORIES = [
  "rate_limited",
  "provider_failure",
  "sms_not_configured",
  "invalid_code",
  "account_ambiguous",
  "account_unavailable",
  "unknown",
] as const;

export type SignupFailureCategory = (typeof SIGNUP_FAILURE_CATEGORIES)[number];

/** Persian labels for the console; the API keeps the stable English keys. */
export const SIGNUP_EVENT_LABELS: Record<SignupEventName, string> = {
  otp_requested: "درخواست کد",
  otp_sent: "کد ارسال‌شده",
  otp_failed: "ارسال/تأیید ناموفق",
  otp_verified: "کد تأییدشده",
  account_created: "حساب ساخته‌شده",
  onboarding_started: "شروع راه‌اندازی",
  onboarding_completed: "پایان راه‌اندازی",
  business_provisioned: "کسب‌وکار ساخته‌شده",
};

export const SIGNUP_FAILURE_LABELS: Record<SignupFailureCategory, string> = {
  rate_limited: "محدودیت نرخ",
  provider_failure: "خطای ارائه‌دهنده",
  sms_not_configured: "پیامک تنظیم نشده",
  invalid_code: "کد نامعتبر",
  account_ambiguous: "حساب مبهم",
  account_unavailable: "حساب غیرفعال",
  unknown: "نامشخص",
};

export function isSignupEventName(value: unknown): value is SignupEventName {
  return typeof value === "string" && (SIGNUP_EVENT_NAMES as readonly string[]).includes(value);
}

export function isSignupFailureCategory(value: unknown): value is SignupFailureCategory {
  return (
    typeof value === "string" && (SIGNUP_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

export interface RecordSignupEventInput {
  event: SignupEventName;
  failureCategory?: SignupFailureCategory | null;
  platformUserId?: string | null;
  businessId?: string | null;
}

/**
 * Append one funnel fact. Best-effort by contract: the caller (a public signup
 * door or the onboarding service) has already made its decision, and a ledger
 * failure must neither roll that back nor turn a safe refusal into a 500.
 *
 * Run inside the caller's platform bypass scope (the signup transactions and
 * the onboarding service both already hold one). Nothing personal is passed or
 * logged — ids only.
 */
export async function recordSignupEvent(input: RecordSignupEventInput): Promise<void> {
  if (!isSignupEventName(input.event)) return;
  const failure =
    input.failureCategory && isSignupFailureCategory(input.failureCategory)
      ? input.failureCategory
      : null;
  try {
    // Inside a signup transaction the ambient query() is already pinned to a
    // bypass connection. A standalone call (the request door's first event)
    // has no scope yet, so it opens the documented platform bypass for exactly
    // this one insert.
    const write = () =>
      query(
        `INSERT INTO platform_signup_events (event, failure_category, platform_user_id, business_id)
         VALUES ($1, $2, $3, $4)`,
        [input.event, failure, input.platformUserId ?? null, input.businessId ?? null],
      );
    await (getTenantScope().kind === "bypass"
      ? write()
      : withoutTenantScope("platform", write));
  } catch (error) {
    console.error("[signup-events] could not record a funnel event", {
      event: input.event,
      failureCategory: failure,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface SignupFunnelCounts {
  event: SignupEventName;
  label: string;
  count: number;
}

export interface SignupFailureCount {
  category: SignupFailureCategory;
  label: string;
  count: number;
}

export interface SignupFunnel {
  windowDays: number;
  totals: SignupFunnelCounts[];
  failures: SignupFailureCount[];
  /** False when no event has ever been recorded (the console's empty state). */
  hasData: boolean;
}

interface FunnelRow {
  [key: string]: unknown;
  event: string;
  failure_category: string | null;
  count: string | number;
}

/**
 * Turn grouped SQL rows into the console's fixed shape.
 *
 * Every known event is present with a zero, so "no OTP was sent" is a figure an
 * operator can read rather than a missing row they have to notice. Unknown
 * names are dropped: the table's CHECK makes them impossible, and inventing a
 * bucket for one would hide a schema drift.
 */
export function aggregateSignupFunnel(
  rows: ReadonlyArray<{ event: unknown; failure_category?: unknown; count: unknown }>,
  windowDays: number,
): SignupFunnel {
  const totals = new Map<SignupEventName, number>(SIGNUP_EVENT_NAMES.map((name) => [name, 0]));
  const failures = new Map<SignupFailureCategory, number>(
    SIGNUP_FAILURE_CATEGORIES.map((category) => [category, 0]),
  );
  let any = false;

  for (const row of rows) {
    if (!isSignupEventName(row.event)) continue;
    const count = Number(row.count);
    const safeCount = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
    totals.set(row.event, (totals.get(row.event) ?? 0) + safeCount);
    if (safeCount > 0) any = true;
    if (row.event === "otp_failed" || row.event === "otp_verified") {
      if (isSignupFailureCategory(row.failure_category)) {
        failures.set(
          row.failure_category,
          (failures.get(row.failure_category) ?? 0) + safeCount,
        );
      }
    }
  }

  return {
    windowDays,
    totals: SIGNUP_EVENT_NAMES.map((event) => ({
      event,
      label: SIGNUP_EVENT_LABELS[event],
      count: totals.get(event) ?? 0,
    })),
    failures: SIGNUP_FAILURE_CATEGORIES.map((category) => ({
      category,
      label: SIGNUP_FAILURE_LABELS[category],
      count: failures.get(category) ?? 0,
    })),
    hasData: any,
  };
}

/** Read the funnel for the last `days` days (bounded 1–90). */
export async function getSignupFunnel(days = 30): Promise<SignupFunnel> {
  const windowDays = Math.min(90, Math.max(1, Math.trunc(days)));
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<FunnelRow>(
      `SELECT event, failure_category, count(*)::text AS count
         FROM platform_signup_events
        WHERE created_at >= now() - ($1::int * interval '1 day')
        GROUP BY event, failure_category`,
      [windowDays],
    );
    return aggregateSignupFunnel(rows, windowDays);
  });
}

// ---------------------------------------------------------------------------
// Authentication SMS readiness
// ---------------------------------------------------------------------------
//
// Authentication SMS is separate from tenant messaging and from Growth billing:
// it is sent by the platform's own managed account (`platform_sms_config`), the
// same one the OTP doors resolve, and it never debits a tenant's wallet. The
// console reads only the safe half of that configuration — never the key, never
// a key hint — plus the operator attention ledger #902 already maintains.

export type AuthSmsStatus = "ready" | "degraded" | "not_configured" | "unknown";

export interface AuthSmsHealth {
  status: AuthSmsStatus;
  configured: boolean;
  otpTemplate: string;
  fromEnvironment: boolean;
  updatedAt: string | null;
  lastSentAt: string | null;
  failures24h: number;
  failureBreakdown: Array<{ category: SignupFailureCategory; label: string; count: number }>;
  openAlerts: { critical: number; warning: number; info: number; total: number };
  alerts: Array<{ kind: string; severity: string; title: string; action: string }>;
}

/**
 * The status rule, pure.
 *
 *  - `unknown` — the configuration or the failure counter could not be read;
 *    claiming "ready" without evidence is the one thing an operations desk must
 *    never be told.
 *  - `not_configured` — no key in the database or environment: no OTP can leave.
 *  - `degraded` — configured, but a critical/warning provider alert is open or
 *    an authentication SMS failed in the last day.
 *  - `ready` — configured, no open alert, no recent failure.
 */
export function authSmsStatus(input: {
  configured: boolean;
  readable: boolean;
  openCritical: number;
  openWarning: number;
  failures24h: number;
}): AuthSmsStatus {
  if (!input.readable) return "unknown";
  if (!input.configured) return "not_configured";
  if (input.openCritical > 0 || input.openWarning > 0 || input.failures24h > 0) return "degraded";
  return "ready";
}

export async function getAuthSmsHealth(): Promise<AuthSmsHealth> {
  return withoutTenantScope("platform", async () => {
    const fallback: AuthSmsHealth = {
      status: "unknown",
      configured: false,
      otpTemplate: "",
      fromEnvironment: false,
      updatedAt: null,
      lastSentAt: null,
      failures24h: 0,
      failureBreakdown: [],
      openAlerts: { critical: 0, warning: 0, info: 0, total: 0 },
      alerts: [],
    };

    let config: Awaited<ReturnType<typeof getPublicSmsConfig>> | null = null;
    try {
      config = await getPublicSmsConfig();
    } catch (error) {
      console.error("[signup-events] could not read the authentication SMS configuration", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }

    let failures: Array<{ category: SignupFailureCategory; label: string; count: number }> = [];
    let lastSentAt: string | null = null;
    let readable = config !== null;
    try {
      const [{ rows: failureRows }, { rows: sentRows }] = await Promise.all([
        query<{ failure_category: string; count: string | number }>(
          `SELECT failure_category, count(*)::text AS count
             FROM platform_signup_events
            WHERE event = 'otp_failed'
              AND created_at >= now() - interval '24 hours'
              AND failure_category IS NOT NULL
            GROUP BY failure_category`,
          [],
        ),
        query<{ last_sent_at: Date | null }>(
          `SELECT max(created_at) FILTER (WHERE event = 'otp_sent') AS last_sent_at
             FROM platform_signup_events
            WHERE created_at >= now() - interval '30 days'`,
          [],
        ),
      ]);
      failures = failureRows
        .filter((row) => isSignupFailureCategory(row.failure_category))
        .map((row) => ({
          category: row.failure_category as SignupFailureCategory,
          label: SIGNUP_FAILURE_LABELS[row.failure_category as SignupFailureCategory],
          count: Number(row.count) || 0,
        }))
        .filter((row) => row.count > 0);
      lastSentAt = sentRows[0]?.last_sent_at?.toISOString() ?? null;
    } catch (error) {
      readable = false;
      console.error("[signup-events] could not read authentication SMS outcomes", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }

    let openAlerts = { critical: 0, warning: 0, info: 0, total: 0 };
    let alerts: AuthSmsHealth["alerts"] = [];
    try {
      const [summary, open] = await Promise.all([
        getServiceAlertSummary(),
        listServiceAlerts({ limit: 5 }),
      ]);
      openAlerts = {
        critical: summary.critical,
        warning: summary.warning,
        info: summary.info,
        total: summary.total,
      };
      alerts = open.map((alert) => ({
        kind: alert.kind,
        severity: alert.severity,
        title: AUTH_SMS_ALERT_LABELS[alert.kind] ?? "هشدار سرویس پیامک",
        action: AUTH_SMS_ALERT_ACTIONS[alert.kind] ?? "وضعیت سرویس پیامک را در پنل بررسی کنید.",
      }));
    } catch (error) {
      // The managed-service ledger is optional for an install that never
      // enabled managed SMS; its absence is not a reason to hide the config.
      console.warn("[signup-events] service alert ledger unavailable", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }

    const failures24h = failures.reduce((sum, row) => sum + row.count, 0);
    return {
      ...fallback,
      status: authSmsStatus({
        configured: config?.configured === true,
        readable,
        openCritical: openAlerts.critical,
        openWarning: openAlerts.warning,
        failures24h,
      }),
      configured: config?.configured === true,
      otpTemplate: config?.otpTemplate ?? "",
      fromEnvironment: config?.fromEnvironment === true,
      updatedAt: config?.updatedAt ?? null,
      lastSentAt,
      failures24h,
      failureBreakdown: failures,
      openAlerts,
      alerts,
    };
  });
}

/**
 * First-party Persian copy for the managed-service alert kinds. The provider
 * name and any raw code stay out of the console; the operator acts on the
 * condition, not on the supplier's vocabulary.
 */
const AUTH_SMS_ALERT_LABELS: Record<string, string> = {
  master_credit_low: "اعتبار حساب پیامک در آستانهٔ پایان است",
  master_balance_unknown: "موجودی حساب پیامک نامشخص است",
  transactional_reserve_held: "اعتبار نگه‌داشته‌شده برای پیام‌های ورود در آستانهٔ پایان است",
  funding_failed: "شارژ حساب پیامک انجام نشد",
  unresolved_transfer: "یک انتقال اعتبار پیامک نامشخص مانده است",
  reconciliation_drift: "مغایرت موجودی حساب پیامک",
  reconciliation_incomplete: "بازخوانی موجودی حساب پیامک انجام نشد",
  account_suspended: "حساب پیامک در دسترس نیست",
  provisioning_failed: "راه‌اندازی حساب پیامک ناموفق بود",
  tariff_missing: "تعرفهٔ پیامک ثبت نشده است",
  fleet_cap_reached: "سقف روزانهٔ شارژ پیامک پر شده است",
  child_cap_reached: "سقف اعتبار پیامک پر شده است",
  daily_cap_reached: "سقف شارژ روزانهٔ پیامک پر شده است",
};

const AUTH_SMS_ALERT_ACTIONS: Record<string, string> = {
  master_credit_low: "اعتبار حساب اصلی پیامک را شارژ کنید.",
  master_balance_unknown: "اتصال و کلید حساب پیامک را در «پیام‌رسانی» بررسی کنید.",
  transactional_reserve_held: "اعتبار حساب اصلی را شارژ کنید؛ سهم پیام‌های ورود حفظ شود.",
  funding_failed: "وضعیت حساب را بررسی و شارژ دستی را تکرار کنید.",
  unresolved_transfer: "نتیجهٔ انتقال را در پنل تأمین‌کننده بررسی کنید؛ انتقال دوباره نکنید.",
  reconciliation_drift: "گردش حساب پیامک را بررسی و مغایرت را ثبت کنید.",
  reconciliation_incomplete: "اتصال به تأمین‌کننده را بررسی کنید؛ پاس بعدی دوباره تلاش می‌کند.",
  account_suspended: "وضعیت حساب را با پنل تأمین‌کننده هم‌خوان کنید.",
  provisioning_failed: "راه‌اندازی حساب را از پنل دوباره اجرا کنید.",
  tariff_missing: "حساب را با تأمین‌کننده همگام کنید.",
  fleet_cap_reached: "سقف روزانه را بالا ببرید یا تا فردا صبر کنید.",
  child_cap_reached: "سقف اعتبار این کسب‌وکار را بازبینی کنید.",
  daily_cap_reached: "سقف شارژ روزانه را بازبینی کنید.",
};

// ---------------------------------------------------------------------------
// Account inspection
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPlatformAccountId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Mask an email for the default view: one leading character plus the domain.
 * An address with no `@` is masked wholesale rather than partially printed.
 */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export interface SignupAccountMembership {
  businessId: string;
  businessName: string;
  isActive: boolean;
}

export interface SignupAccountSummary {
  accountId: string;
  fullName: string;
  /** Masked by default; a reveal is a separate, audited, permission-gated call. */
  maskedPhone: string | null;
  maskedEmail: string | null;
  isActive: boolean;
  phoneVerified: boolean;
  emailVerified: boolean;
  createdAt: string;
  onboarding: {
    started: boolean;
    submitted: boolean;
    provisionedBusinessId: string | null;
  };
  memberships: SignupAccountMembership[];
}

interface AccountRow {
  [key: string]: unknown;
  id: string;
  full_name: string;
  phone_e164: string | null;
  email: string | null;
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
  is_active: boolean;
  created_at: Date;
}

/**
 * Look one account up by its global identity id.
 *
 * Search-by-id only: there is no name/phone/email search, so the endpoint
 * cannot be used to enumerate people. The returned shape is masked and carries
 * no national ID, password/hash, OTP row or provider detail.
 */
export async function findSignupAccount(accountId: string): Promise<SignupAccountSummary | null> {
  if (!isPlatformAccountId(accountId)) return null;
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<AccountRow>(
      `SELECT id, full_name, phone_e164, email::text AS email,
              email_verified_at, phone_verified_at, is_active, created_at
         FROM platform_users
        WHERE id = $1`,
      [accountId],
    );
    const account = rows[0];
    if (!account) return null;

    const [{ rows: membershipRows }, { rows: draftRows }] = await Promise.all([
      query<{ business_id: string; name: string; is_active: boolean }>(
        `SELECT u.business_id, b.name, u.is_active
           FROM users u
           JOIN businesses b ON b.id = u.business_id
          WHERE u.platform_user_id = $1
          ORDER BY b.name`,
        [accountId],
      ),
      query<{ submitted_at: Date | null; provisioned_business_id: string | null; completed_steps: string[] | null }>(
        `SELECT submitted_at, provisioned_business_id, completed_steps
           FROM platform_onboarding_drafts
          WHERE platform_user_id = $1`,
        [accountId],
      ),
    ]);

    const draft = draftRows[0];
    return {
      accountId: account.id,
      fullName: account.full_name,
      maskedPhone: account.phone_e164 ? maskPhoneE164(account.phone_e164) : null,
      maskedEmail: maskEmail(account.email),
      isActive: account.is_active,
      phoneVerified: account.phone_verified_at !== null,
      emailVerified: account.email !== null && account.email_verified_at !== null,
      createdAt: account.created_at.toISOString(),
      onboarding: {
        started: Boolean(draft && (draft.completed_steps?.length ?? 0) > 0),
        submitted: Boolean(draft?.submitted_at),
        provisionedBusinessId: draft?.provisioned_business_id ?? null,
      },
      memberships: membershipRows.map((row) => ({
        businessId: row.business_id,
        businessName: row.name,
        isActive: row.is_active,
      })),
    };
  });
}

export interface SignupAccountContact {
  accountId: string;
  fullName: string;
  phone: string | null;
  email: string | null;
}

/**
 * The unmasked contact details. Callers must hold `signup.inspect` and write
 * the `signup.account.reveal` audit row in the same request; this function has
 * no capability check of its own because it is only ever called from that one
 * audited route.
 *
 * Still absent, on purpose: national ID (encrypted or not), password/hash, OTP
 * rows, session tokens and provider configuration.
 */
export async function revealSignupAccountContact(
  accountId: string,
): Promise<SignupAccountContact | null> {
  if (!isPlatformAccountId(accountId)) return null;
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ id: string; full_name: string; phone_e164: string | null; email: string | null }>(
      `SELECT id, full_name, phone_e164, email::text AS email
         FROM platform_users
        WHERE id = $1`,
      [accountId],
    );
    const account = rows[0];
    if (!account) return null;
    return {
      accountId: account.id,
      fullName: account.full_name,
      phone: account.phone_e164,
      email: account.email,
    };
  });
}
