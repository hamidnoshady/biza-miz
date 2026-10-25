/**
 * Service activation & runtime billing — the vocabulary and the arithmetic.
 *
 * Issue #1041 adds ONE new charge to the business's existing wallet:
 *
 *   1. a one-time setup fee per business per *stable service identity*, and
 *   2. a per-enabled-hour availability tariff for as long as the service is
 *      deliberately left enabled,
 *
 * plus a Superadmin retention policy that starts counting only after the
 * customer disables the service themselves.
 *
 * This file is framework-free on purpose (no `db`, no `next`): the tenant
 * service screens, the super-admin console, the API guards and the settlement
 * worker all import the same rules, and every one of them is unit-tested here.
 *
 * Boundaries this module encodes:
 *
 * - **Apps** are the four keys of `src/lib/apps.ts`. The website app's two
 *   internal managers (Eshobe CMS and WordPress/Woo) are NOT separate billable
 *   services.
 * - **Workspace** entries are separately priced *My Workspace business
 *   capabilities*, never the shell, navigation, billing, shared account/
 *   security/settings, customer export or login.
 * - **Agents** are Superadmin-published background agents/routines. The AI chat
 *   home is not one of them: interactive assistant turns stay token/credit
 *   metered exactly as before.
 *
 * Money is integer Rial everywhere (the UI displays Toman). Enabled time is
 * measured in whole seconds and prorated per second; a settlement segment's
 * amount is rounded UP to the Rial once, which is deterministic and never bills
 * the same second twice because the interval cursor only moves forward.
 */

// ---------------------------------------------------------------------------
// Service identity
// ---------------------------------------------------------------------------

export const SERVICE_KINDS = ["app", "workspace", "agent"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export function isServiceKind(value: unknown): value is ServiceKind {
  return typeof value === "string" && (SERVICE_KINDS as readonly string[]).includes(value);
}

export interface ServiceIdentity {
  kind: ServiceKind;
  key: string;
  /** '' for apps, workspace capabilities and per-agent singletons. */
  runtimeInstanceId?: string;
}

/** A stable, human-readable identity key used in logs, event ids and locks. */
export function serviceIdentityKey(identity: ServiceIdentity): string {
  const runtime = identity.runtimeInstanceId?.trim() || "";
  return runtime ? `${identity.kind}:${identity.key}#${runtime}` : `${identity.kind}:${identity.key}`;
}

export interface ServiceDefinition {
  kind: ServiceKind;
  key: string;
  label: string;
  description: string;
}

/**
 * The four standalone business apps, by their canonical keys. Duplicated as
 * literals (not imported from `apps.ts`) so this module stays client-safe; a
 * unit test asserts the two lists are identical, so a fifth app cannot appear
 * in one place and not the other.
 */
export const APP_SERVICE_DEFINITIONS: readonly ServiceDefinition[] = [
  {
    kind: "app",
    key: "accounting",
    label: "حسابداری",
    description: "فروش و صندوق، سفارش‌ها، عملیات، خرید و انبار، دفتر و گزارش‌ها.",
  },
  {
    kind: "app",
    key: "crm",
    label: "ارتباط با مشتری",
    description: "پروندهٔ مشتری، بخش‌بندی، قیف فروش، پیگیری‌ها و تیکت‌های خدمات.",
  },
  {
    kind: "app",
    key: "growth",
    label: "رشد و بازاریابی",
    description: "وفاداری، کمپین، کارت هدیه، پیامک و کمیسیون.",
  },
  {
    kind: "app",
    key: "website",
    label: "مدیریت وب‌سایت",
    description: "سایت‌ساز Eshobe و مدیریت وردپرس/ووکامرس، هر دو در یک برنامه.",
  },
];

/**
 * Separately priced My Workspace business capabilities. These are features the
 * owner chooses to sell individually; the workspace shell itself is never a
 * billable service and is never hidden from the customer.
 */
export const WORKSPACE_SERVICE_DEFINITIONS: readonly ServiceDefinition[] = [
  {
    kind: "workspace",
    key: "projects",
    label: "مدیریت پروژه‌ها",
    description: "پروژه‌ها، نقشه‌ها و پیگیری پیشرفت کار در فضای کار.",
  },
  {
    kind: "workspace",
    key: "documents",
    label: "اسناد و مدارک",
    description: "آرشیو نسخه‌دار اسناد و مدارک کسب‌وکار در فضای کار.",
  },
  {
    kind: "workspace",
    key: "media-library",
    label: "کتابخانهٔ رسانه",
    description: "نگهداری، جست‌وجو و استفادهٔ دوباره از فایل‌های رسانه.",
  },
];

export const STATIC_SERVICE_DEFINITIONS: readonly ServiceDefinition[] = [
  ...APP_SERVICE_DEFINITIONS,
  ...WORKSPACE_SERVICE_DEFINITIONS,
];

export function serviceDefinition(
  kind: ServiceKind,
  key: string,
): ServiceDefinition | null {
  return STATIC_SERVICE_DEFINITIONS.find((row) => row.kind === kind && row.key === key) ?? null;
}

/**
 * Is this key a service of this kind? Apps and workspace capabilities are a
 * closed registry (so a typo cannot create a phantom priced service); agents
 * are dynamic — the Superadmin publishes them and the price catalogue is the
 * authority for which ones exist.
 */
export function isServiceKey(kind: ServiceKind, key: string): boolean {
  if (typeof key !== "string" || key.trim().length === 0) return false;
  if (kind === "agent") return /^[a-z0-9][a-z0-9_.-]{1,127}$/i.test(key.trim());
  return serviceDefinition(kind, key.trim()) != null;
}

// ---------------------------------------------------------------------------
// Lifecycle states
// ---------------------------------------------------------------------------

export const SERVICE_STATES = [
  "setup_in_progress",
  "payment_reserved",
  "active",
  "disabled_retained",
  "eligible_for_purge",
  "purging",
  "data_purged",
  "suspended_insufficient_credit",
  "platform_unavailable",
  "legal_hold",
  "purge_failed",
] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

export function isServiceState(value: unknown): value is ServiceState {
  return typeof value === "string" && (SERVICE_STATES as readonly string[]).includes(value);
}

export interface ServiceStateMeta {
  label: string;
  /** The service is running and can be used. */
  enabled: boolean;
  /** The runtime clock is running and this state accrues hourly charges. */
  billable: boolean;
  /** Data still exists and is readable/exportable per the customer's permission. */
  retainsData: boolean;
  /** This state is a customer disable, so a retention countdown may run. */
  customerDisabled: boolean;
  /** True when automatic destruction may be queued for this state. */
  purgeEligible: boolean;
}

export const SERVICE_STATE_META: Record<ServiceState, ServiceStateMeta> = {
  setup_in_progress: {
    label: "در حال راه‌اندازی",
    enabled: false,
    billable: false,
    retainsData: true,
    customerDisabled: false,
    purgeEligible: false,
  },
  payment_reserved: {
    label: "در انتظار پرداخت",
    enabled: false,
    billable: false,
    retainsData: true,
    customerDisabled: false,
    purgeEligible: false,
  },
  active: {
    label: "فعال",
    enabled: true,
    billable: true,
    retainsData: true,
    customerDisabled: false,
    purgeEligible: false,
  },
  disabled_retained: {
    label: "غیرفعال — داده‌ها نگهداری می‌شود",
    enabled: false,
    billable: false,
    retainsData: true,
    customerDisabled: true,
    purgeEligible: true,
  },
  eligible_for_purge: {
    label: "واجد شرایط پاک‌سازی",
    enabled: false,
    billable: false,
    retainsData: true,
    customerDisabled: true,
    purgeEligible: true,
  },
  purging: {
    label: "در حال پاک‌سازی",
    enabled: false,
    billable: false,
    retainsData: false,
    customerDisabled: true,
    purgeEligible: false,
  },
  data_purged: {
    label: "داده‌های سرویس پاک شده است",
    enabled: false,
    billable: false,
    retainsData: false,
    customerDisabled: true,
    purgeEligible: false,
  },
  suspended_insufficient_credit: {
    label: "متوقف — اعتبار کیف پول کافی نیست",
    enabled: false,
    billable: false,
    retainsData: true,
    customerDisabled: false,
    purgeEligible: false,
  },
  platform_unavailable: {
    label: "متوقف — سرویس پلتفرم در دسترس نیست",
    enabled: false,
    billable: false,
    retainsData: true,
    customerDisabled: false,
    purgeEligible: false,
  },
  legal_hold: {
    label: "نگهداری حقوقی",
    enabled: false,
    billable: false,
    retainsData: true,
    customerDisabled: false,
    purgeEligible: false,
  },
  purge_failed: {
    label: "پاک‌سازی ناموفق",
    enabled: false,
    billable: false,
    retainsData: true,
    customerDisabled: true,
    purgeEligible: false,
  },
};

/** States that only a suspension can produce — never a customer disable. */
export const SUSPENSION_REASONS = [
  "insufficient_credit",
  "platform_unavailable",
  "maintenance",
  "legal_hold",
  "trial_grace",
] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

/** The DB state a suspension reason maps to. */
export const SUSPENSION_STATE: Record<SuspensionReason, ServiceState> = {
  insufficient_credit: "suspended_insufficient_credit",
  platform_unavailable: "platform_unavailable",
  maintenance: "platform_unavailable",
  legal_hold: "legal_hold",
  trial_grace: "suspended_insufficient_credit",
};

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

export const SECONDS_PER_HOUR = 3600;
/**
 * Deterministic minimum unit for an *open* interval: a settlement pass only
 * bills a full unit, so a five-minute worker cannot write one ledger row per
 * tick. A closing interval (disable/suspension) settles every remaining second,
 * which is what makes "1h20m enabled = 80 minutes billed" exact.
 */
export const MINIMUM_BILLING_UNIT_SECONDS = 60;

export type SetupMode = "fixed" | "hour_equivalent";

export interface ServiceTariff {
  /** Price version this tariff was published as. */
  version: number;
  setupMode: SetupMode;
  setupFixedRial: number;
  setupEquivalentHours: number;
  hourlyRateRial: number;
  published?: boolean;
  effectiveFrom?: string;
}

function nonNegativeInt(value: unknown): number {
  const n = Math.floor(Number(value ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("invalid_denominator");
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

/** Hours as integer hundredths, so 0.5h and 72h are both exact. */
function hoursToHundredths(hours: number): bigint {
  const value = Number(hours);
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid_hours");
  return BigInt(Math.round(value * 100));
}

/**
 * The one-time setup fee for a tariff.
 *
 * - `fixed` → the Rial amount as published.
 * - `hour_equivalent` → N hours × this tariff's enabled-hour rate. It is a
 *   *setup-fee equivalent* (the issue's 72-hour / 3-day example), never N
 *   hours of pre-paid runtime.
 *
 * Zero is a legitimate, explicitly published value.
 */
export function setupFeeRial(tariff: ServiceTariff): number {
  const rate = nonNegativeInt(tariff.hourlyRateRial);
  if (tariff.setupMode === "fixed") return nonNegativeInt(tariff.setupFixedRial);
  if (tariff.setupMode !== "hour_equivalent") throw new Error("invalid_setup_mode");
  const amount = ceilDiv(hoursToHundredths(tariff.setupEquivalentHours) * BigInt(rate), 100n);
  return Number(amount);
}

/**
 * Prorated enabled-time price for a whole number of seconds, rounded up to the
 * Rial. `enabledRialForSeconds(4800, 360_000)` is 480,000 Rial for 1h20m.
 */
export function enabledRialForSeconds(seconds: number, hourlyRateRial: number): number {
  const secs = Math.floor(Number(seconds));
  if (!Number.isFinite(secs) || secs < 0) throw new Error("invalid_seconds");
  const rate = nonNegativeInt(hourlyRateRial);
  if (secs === 0 || rate === 0) return 0;
  return Number(ceilDiv(BigInt(secs) * BigInt(rate), BigInt(SECONDS_PER_HOUR)));
}

/** Whole elapsed seconds between two instants, never negative. */
export function billableSecondsBetween(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("invalid_instant");
  if (end <= start) return 0;
  return Math.floor((end - start) / 1000);
}

/** One hour at the tariff — the startup interval the first reserve must cover. */
export function firstHourRial(tariff: ServiceTariff): number {
  return enabledRialForSeconds(SECONDS_PER_HOUR, tariff.hourlyRateRial);
}

/** The wallet cover required to start: setup debit + the first enabled hour. */
export function firstIntervalReserveRial(tariff: ServiceTariff): number {
  return setupFeeRial(tariff) + firstHourRial(tariff);
}

export const SERVICE_ADDITIONAL_CHARGES: Record<ServiceKind, readonly string[]> = {
  app: [
    "مصرف هوش مصنوعی (توکن) جداگانه از کیف پول کسر می‌شود.",
    "پیامک، فضای رسانه و ترافیک سایت طبق مصرف جداگانه محاسبه می‌شود.",
  ],
  workspace: [
    "مصرف هوش مصنوعی و فضای رسانه جداگانه از کیف پول کسر می‌شود.",
  ],
  agent: [
    "هر فراخوانی مدل هوش مصنوعی جداگانه (اعتبار توکن) محاسبه می‌شود؛ هزینهٔ ساعتی فقط بابت در دسترس بودنِ پس‌زمینه است.",
  ],
};

export type QuoteEligibility = "ready" | "not_configured" | "insufficient_credit";

export interface ActivationQuote {
  identity: ServiceIdentity;
  /** Null when no published tariff covers this service (fail closed). */
  tariff: ServiceTariff | null;
  eligible: boolean;
  reason: QuoteEligibility;
  setupRial: number;
  hourlyRial: number;
  firstHourRial: number;
  /** What the wallet must hold before the first activation may proceed. */
  reserveRial: number;
  estimated24hRial: number;
  estimated30dRial: number;
  walletBalanceRial: number;
  balanceAfterSetupRial: number;
  additionalCharges: readonly string[];
}

/**
 * The quote shown before the irreversible debit. A missing or unpublished
 * tariff is NOT free: it makes the service ineligible ("fail closed"), because
 * an unpriced new agent must never activate on an assumed default.
 */
export function quoteServiceActivation(input: {
  identity: ServiceIdentity;
  tariff: ServiceTariff | null;
  walletBalanceRial: number;
  nowIso?: string;
}): ActivationQuote {
  const balance = Number.isFinite(input.walletBalanceRial)
    ? Math.max(0, Math.floor(input.walletBalanceRial))
    : 0;
  const tariff = input.tariff;
  const published = tariff != null && tariff.published !== false;
  if (!tariff || !published) {
    return {
      identity: input.identity,
      tariff: null,
      eligible: false,
      reason: "not_configured",
      setupRial: 0,
      hourlyRial: 0,
      firstHourRial: 0,
      reserveRial: 0,
      estimated24hRial: 0,
      estimated30dRial: 0,
      walletBalanceRial: balance,
      balanceAfterSetupRial: balance,
      additionalCharges: SERVICE_ADDITIONAL_CHARGES[input.identity.kind],
    };
  }
  const setup = setupFeeRial(tariff);
  const hourly = nonNegativeInt(tariff.hourlyRateRial);
  const firstHour = firstHourRial(tariff);
  const reserve = setup + firstHour;
  return {
    identity: input.identity,
    tariff,
    eligible: balance >= reserve,
    reason: balance >= reserve ? "ready" : "insufficient_credit",
    setupRial: setup,
    hourlyRial: hourly,
    firstHourRial: firstHour,
    reserveRial: reserve,
    estimated24hRial: enabledRialForSeconds(24 * SECONDS_PER_HOUR, hourly),
    estimated30dRial: enabledRialForSeconds(30 * 24 * SECONDS_PER_HOUR, hourly),
    walletBalanceRial: balance,
    balanceAfterSetupRial: Math.max(0, balance - setup),
    additionalCharges: SERVICE_ADDITIONAL_CHARGES[input.identity.kind],
  };
}

// ---------------------------------------------------------------------------
// Retention policy
// ---------------------------------------------------------------------------

export const RETENTION_MIN_DAYS = 1;
/** Ten years. A longer window is almost always a mistake, and "never" is explicit. */
export const RETENTION_MAX_DAYS = 3650;
export const RETENTION_PRESET_DAYS = [7, 30, 90, 365] as const;

export interface RetentionPolicy {
  /** false = keep data indefinitely; no automatic destruction. */
  autoPurgeEnabled: boolean;
  /** Null means indefinite (only valid when autoPurgeEnabled is false). */
  retentionDays: number | null;
  notificationLeadDays: number;
  exportGraceDays: number;
  policyVersion: number;
  source: "platform" | "business" | "none";
}

/**
 * The safe default: no row anywhere means keep everything. A service must be
 * *explicitly* given a retention window, so an upgrade can never start deleting
 * data that predates this feature.
 */
export const NO_AUTO_DELETE_POLICY: RetentionPolicy = {
  autoPurgeEnabled: false,
  retentionDays: null,
  notificationLeadDays: 7,
  exportGraceDays: 7,
  policyVersion: 0,
  source: "none",
};

export class RetentionPolicyError extends Error {
  constructor(public code: "invalid_retention_days" | "indefinite_requires_disabled_purge") {
    super(code);
  }
}

/**
 * Validate and normalise a policy the operator submitted. Invalid input is a
 * typed error, never a silent clamp that could delete data earlier than asked.
 */
export function normalizeRetentionPolicy(input: {
  autoPurgeEnabled?: boolean | null;
  retentionDays?: number | null;
  notificationLeadDays?: number | null;
  exportGraceDays?: number | null;
  policyVersion?: number | null;
  source?: RetentionPolicy["source"];
}): RetentionPolicy {
  const autoPurgeEnabled = input.autoPurgeEnabled === true;
  const rawDays = input.retentionDays;
  const days =
    rawDays == null || rawDays === undefined
      ? null
      : Math.floor(Number(rawDays));
  if (days != null) {
    if (!Number.isSafeInteger(days) || days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) {
      throw new RetentionPolicyError("invalid_retention_days");
    }
  }
  if (autoPurgeEnabled && days == null) {
    throw new RetentionPolicyError("indefinite_requires_disabled_purge");
  }
  const lead = Math.floor(Number(input.notificationLeadDays ?? 7));
  const grace = Math.floor(Number(input.exportGraceDays ?? 7));
  const version = Math.floor(Number(input.policyVersion ?? 1));
  return {
    autoPurgeEnabled,
    retentionDays: days,
    notificationLeadDays: Number.isFinite(lead) && lead >= 0 ? lead : 7,
    exportGraceDays: Number.isFinite(grace) && grace >= 0 ? grace : 7,
    policyVersion: Number.isFinite(version) && version > 0 ? version : 1,
    source: input.source ?? "platform",
  };
}

/**
 * The destruction instant for a customer disable, or null when the policy has
 * no automatic destruction. Never called for a suspension.
 */
export function retentionDeadline(disabledAtIso: string, policy: RetentionPolicy): string | null {
  if (!policy.autoPurgeEnabled || policy.retentionDays == null) return null;
  const disabledAt = Date.parse(disabledAtIso);
  if (!Number.isFinite(disabledAt)) throw new Error("invalid_instant");
  return new Date(disabledAt + policy.retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

/** When the customer should first be warned (informational; the UI reads it). */
export function retentionWarningAt(deadlineIso: string, policy: RetentionPolicy): string | null {
  const deadline = Date.parse(deadlineIso);
  if (!Number.isFinite(deadline)) return null;
  return new Date(deadline - Math.max(0, policy.notificationLeadDays) * 24 * 60 * 60 * 1000).toISOString();
}

export interface PurgeEligibilityInput {
  state: ServiceState;
  retentionDeadline: string | null;
  nowIso: string;
  /** Legal/operational hold always wins over an expired deadline. */
  legalHold?: boolean;
}

export type PurgeBlockReason =
  | "not_disabled"
  | "no_deadline"
  | "not_due"
  | "legal_hold"
  | "already_purged"
  | "purge_in_progress";

/** May the destruction worker act on this activation right now? */
export function purgeBlockReason(input: PurgeEligibilityInput): PurgeBlockReason | null {
  if (input.legalHold || input.state === "legal_hold") return "legal_hold";
  if (input.state === "data_purged") return "already_purged";
  if (input.state === "purging") return "purge_in_progress";
  const meta = SERVICE_STATE_META[input.state];
  if (!meta?.customerDisabled) return "not_disabled";
  if (!input.retentionDeadline) return "no_deadline";
  const deadline = Date.parse(input.retentionDeadline);
  const now = Date.parse(input.nowIso);
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) return "not_due";
  return now >= deadline ? null : "not_due";
}

// ---------------------------------------------------------------------------
// What a purge may touch — the service data ownership manifest
// ---------------------------------------------------------------------------

export type PurgeClassification = "owned" | "shared" | "external" | "protected";
export type PurgeAction = "delete" | "block" | "preserve";

export interface PurgeScopeEntry {
  /** Machine key of the dataset; also what the journal records. */
  dataset: string;
  classification: PurgeClassification;
  action: PurgeAction;
  /** Why, in the operator's words — shown in the dry-run plan and the journal. */
  reason: string;
}

/**
 * Datasets a service purge must never delete, whatever the service: the
 * commercial and financial evidence issue #1041 §D requires to survive.
 */
export const PROTECTED_PURGE_ENTRIES: readonly PurgeScopeEntry[] = [
  {
    dataset: "service.activation_record",
    classification: "protected",
    action: "preserve",
    reason:
      "رکورد فعال‌سازی و اثبات پرداخت یک‌بارهٔ راه‌اندازی پس از پاک‌سازی هم می‌ماند (#1041 §D).",
  },
  {
    dataset: "wallet.ledger",
    classification: "protected",
    action: "preserve",
    reason: "کیف پول، پرداخت‌ها، فاکتورها و ردیف‌های دفتر، سابقهٔ مالی تغییرناپذیرند.",
  },
  {
    dataset: "billing.usage_events",
    classification: "protected",
    action: "preserve",
    reason: "رویدادهای مصرف و تسویه‌های ساعتی، سابقهٔ مالی و قابل حسابرسی‌اند.",
  },
];

/**
 * The one dataset this release can safely claim as service-owned: the service's
 * own resumable setup state, written by this feature. It is deleted by the
 * purge worker after the retention window.
 */
export const OWNED_PURGE_ENTRIES: readonly PurgeScopeEntry[] = [
  {
    dataset: "service.wizard_state",
    classification: "owned",
    action: "delete",
    reason: "دادهٔ راه‌اندازی و پیش‌نویس تنظیماتِ همین سرویس؛ تنها دادهٔ کاملاً متعلق به سرویس.",
  },
];

/**
 * Datasets whose ownership has NOT been reviewed yet (issue #1041 orders a
 * reviewed table/object ownership manifest, coordinated with #926 media and
 * #903 backups). They are reported as blocked, so a purge run is honestly
 * "partial" rather than silently deleting another app's canonical records.
 */
const OWNERSHIP_REVIEW_PENDING: Record<ServiceKind, readonly PurgeScopeEntry[]> = {
  app: [
    {
      dataset: "app.operational_data",
      classification: "shared",
      action: "block",
      reason:
        "دادهٔ عملیاتی برنامه ممکن است با برنامه‌های دیگر یا سوابق حسابداری مشترک باشد؛ تا نهایی‌شدن فهرست مالکیت (#926/#903) حذف نمی‌شود.",
    },
  ],
  workspace: [
    {
      dataset: "workspace.business_data",
      classification: "shared",
      action: "block",
      reason:
        "دادهٔ قابلیت فضای کار ممکن است به پرونده‌های مشتری و سوابق مشترک ارجاع دهد؛ تا بازبینی مالکیت حذف نمی‌شود.",
    },
  ],
  agent: [
    {
      dataset: "agent.runtime_artifacts",
      classification: "shared",
      action: "block",
      reason:
        "تاریخ اجرا و حافظهٔ عامل با گفت‌وگوی هوش مصنوعی مشترک است؛ حذف تا بازبینی مالکیت انجام نمی‌شود.",
    },
  ],
};

/** The reviewed plan for one service identity (see the two constants above). */
export function purgeManifestFor(kind: ServiceKind): PurgeScopeEntry[] {
  return [...OWNED_PURGE_ENTRIES, ...PROTECTED_PURGE_ENTRIES, ...OWNERSHIP_REVIEW_PENDING[kind]];
}

/** A run is complete only when every blocked entry has been resolved. */
export function purgePlanStatus(entries: readonly PurgeScopeEntry[]): "completed" | "partial" {
  return entries.some((entry) => entry.action === "block") ? "partial" : "completed";
}

// ---------------------------------------------------------------------------
// Presentation helpers (Shamsi-only dates are formatted in the screens)
// ---------------------------------------------------------------------------

/** Rial → Toman for display, as integer Toman. */
export function rialToToman(rial: number): number {
  return Math.floor(Math.max(0, Math.floor(rial)) / 10);
}

/** A short, stable label for a service identity (the screens add the app name). */
export function serviceLabel(kind: ServiceKind, key: string): string {
  return serviceDefinition(kind, key)?.label ?? key;
}
