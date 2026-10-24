/**
 * Issue #974 — pure, framework-free contract for Full Offline (`local`)
 * Cloud activation, device/business validation & refresh, lock enforcement,
 * diagnostic redaction, and remote support permissions.
 *
 * Kept free of `node:crypto`, `pg`, and Next server imports so client UI,
 * server routes, background workers, and fast unit tests share the exact same
 * state machine and security boundaries.
 */

export const LOCAL_ACTIVATION_PROTOCOL_VERSION = "biza_local_activation_v1" as const;

export const LOCAL_ACTIVATION_STATES = [
  "not_enrolled",
  "validating",
  "active",
  "validation_pending",
  "locked_invalid",
] as const;

export type LocalActivationState = (typeof LOCAL_ACTIVATION_STATES)[number];

/**
 * Confirmed authenticated/explicit denial codes returned by the Cloud
 * activation protocol (`401`/`403` carrying `protocol: biza_local_activation_v1`).
 *
 * Transient transport errors (offline, DNS, TLS handshake failure, timeout,
 * proxy HTML, 429, 5xx) are NEVER in this set and NEVER transition an
 * installation into `locked_invalid`.
 */
export const CONFIRMED_CLOUD_DENIAL_CODES = [
  "credential_invalid",
  "credential_revoked",
  "device_revoked",
  "device_disabled",
  "business_disabled",
  "business_suspended",
  "business_archived",
  "business_mismatch",
  "installation_mismatch",
  "profile_not_allowed",
  "entitlement_denied",
  "offline_lease_expired",
] as const;

export type ConfirmedCloudDenialCode = (typeof CONFIRMED_CLOUD_DENIAL_CODES)[number];

const DENIAL_SET = new Set<string>(CONFIRMED_CLOUD_DENIAL_CODES);

export function isConfirmedCloudDenial(input: {
  httpStatus: number;
  protocol?: string | null;
  code?: string | null;
}): input is { httpStatus: number; protocol: string; code: ConfirmedCloudDenialCode } {
  if (input.httpStatus !== 401 && input.httpStatus !== 403) return false;
  if (input.protocol !== LOCAL_ACTIVATION_PROTOCOL_VERSION) return false;
  return typeof input.code === "string" && DENIAL_SET.has(input.code);
}

export type ValidationOutcome =
  | { kind: "begin_validation" }
  | { kind: "validated_ok" }
  | {
      kind: "transient_failure";
      reason:
        | "internet_offline"
        | "dns_error"
        | "tls_error"
        | "timeout"
        | "cloud_5xx"
        | "rate_limited"
        | "network_error";
    }
  | { kind: "confirmed_denial"; code: ConfirmedCloudDenialCode }
  | { kind: "offline_lease_expired"; clockRollbackDetected?: boolean };

export interface ActivationTransitionResult {
  nextState: LocalActivationState;
  lockReason: ConfirmedCloudDenialCode | null;
  /** Operational POS/orders/accounting remain usable unless `nextState === 'locked_invalid'`. */
  localOperationsAllowed: boolean;
}

/**
 * Deterministic state machine for Full Offline Cloud activation & validation:
 *
 *   not_enrolled -> validating -> active
 *   active -> validation_pending (on offline / DNS / TLS / timeout / 5xx)
 *   validation_pending -> active (on validated_ok)
 *   active | validation_pending -> locked_invalid (ONLY on confirmed Cloud denial or enforced lease expiry)
 *   locked_invalid -> validating -> active (ONLY via valid credential re-enrollment for the same business)
 *
 * Notice that a `transient_failure` while ALREADY `locked_invalid` keeps the
 * installation in `locked_invalid` — disconnecting the network cable can never
 * downgrade `locked_invalid` back to `validation_pending`!
 */
export function computeNextActivationState(
  currentState: LocalActivationState,
  currentLockReason: ConfirmedCloudDenialCode | null,
  outcome: ValidationOutcome,
): ActivationTransitionResult {
  switch (outcome.kind) {
    case "begin_validation": {
      if (currentState === "locked_invalid") {
        // Stay locked while attempting credential replacement until Cloud confirms success.
        return {
          nextState: "locked_invalid",
          lockReason: currentLockReason ?? "credential_invalid",
          localOperationsAllowed: false,
        };
      }
      const next = currentState === "active" ? "active" : "validating";
      return { nextState: next, lockReason: null, localOperationsAllowed: true };
    }
    case "validated_ok":
      return { nextState: "active", lockReason: null, localOperationsAllowed: true };
    case "transient_failure": {
      if (currentState === "locked_invalid") {
        return {
          nextState: "locked_invalid",
          lockReason: currentLockReason ?? "credential_invalid",
          localOperationsAllowed: false,
        };
      }
      if (currentState === "not_enrolled") {
        return { nextState: "not_enrolled", lockReason: null, localOperationsAllowed: true };
      }
      return {
        nextState: "validation_pending",
        lockReason: null,
        localOperationsAllowed: true,
      };
    }
    case "confirmed_denial":
      return {
        nextState: "locked_invalid",
        lockReason: outcome.code,
        localOperationsAllowed: false,
      };
    case "offline_lease_expired":
      return {
        nextState: "locked_invalid",
        lockReason: "offline_lease_expired",
        localOperationsAllowed: false,
      };
  }
}

/** Healthy background validation interval: every 6 hours while online, plus startup & reconnect. */
export const HEALTHY_VALIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Minimum gap between automatic background validation attempts (rate-limit discipline). */
export const MIN_AUTO_VALIDATION_GAP_MS = 30 * 1000;

/**
 * Exponential retry backoff with bounded +/-20% jitter for `validation_pending`.
 * Capped at 15 minutes so reconnect recovery stays responsive without hammering Cloud.
 */
export function computeValidationBackoffMs(
  consecutiveFailures: number,
  randomUnit = 0.5,
): number {
  const baseStepsMs = [
    30_000,
    60_000,
    120_000,
    300_000,
    600_000,
    900_000,
  ];
  const idx = Math.max(0, Math.min(baseStepsMs.length - 1, consecutiveFailures - 1));
  const base = baseStepsMs[idx];
  const clamped = Math.max(0, Math.min(1, randomUnit));
  const jitterFactor = 0.8 + clamped * 0.4; // [0.8, 1.2]
  return Math.round(base * jitterFactor);
}

/**
 * Explicit domain-authority classification for Full Offline Cloud refresh.
 *
 * Cloud validation updates ONLY the `cloud_authoritative` metadata/policy
 * domains below and NEVER touches `site_authoritative` operational rows or
 * `device_local` settings, and NEVER enables Hybrid `sync_events`.
 */
export const LOCAL_CLOUD_REFRESH_AUTHORITY = {
  cloudAuthoritative: [
    "business_identity", // businesses.name, industry, canonical cloud_business_id
    "business_status", // businesses.status (active | suspended | archived)
    "plan_and_entitlements", // businesses.plan, business_features, business_app_availability
    "primary_location_metadata", // bound location name, address, phone
    "security_and_device_policies", // support_access_policy, desktop min version, offline lease, rotation flag
    "cloud_business_profile", // local_activation.cloud_business_profile setting
  ],
  neverOverwrittenLocal: [
    "orders_and_pos",
    "payments_and_returns",
    "shifts_and_cash_drawer",
    "inventory_and_stock",
    "customers_and_crm",
    "menu_and_items_catalogue",
    "chart_of_accounts_and_journals",
    "local_users_passwords_pins_totp_sessions",
    "printers_and_hardware",
    "local_backups_and_restore",
    "deployment_profile_and_sync_config",
  ],
} as const;

/**
 * Narrow server/API allowlist when a Full Offline installation is in
 * `locked_invalid` state.
 *
 * Enforced inside `withTenantScope` across BOTH Electron loopback and any LAN
 * browser/tablet clients:
 *   - Auth & session inspection/sign-out remain reachable so the Owner can log in
 *   - Connection & activation status / token replacement / Cloud URL repair / diagnostics remain reachable
 *   - Encrypted backup & read-only data export remain reachable so data is never held hostage
 *   - Read-only local audit log remains reachable
 *   - Every operational POS, order, payment, inventory, accounting, menu, customer,
 *     and staff-mutation endpoint is rejected with HTTP 423 Locked.
 */
export function isAllowedWhenLocalInstallationLocked(
  pathname: string,
  method: string,
): boolean {
  const upperMethod = method.toUpperCase();
  const isRead = upperMethod === "GET" || upperMethod === "HEAD";

  // 1. Auth & session management (sign-in, MFA, sign-out, session check)
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return true;
  if (pathname === "/api/health") return true;

  // 2. Connection & Full Offline activation diagnostics / credential repair / remote recovery consent
  if (pathname === "/api/connection/status") return true;
  if (pathname === "/api/local-activation" || pathname.startsWith("/api/local-activation/")) {
    return true;
  }

  // 3. Local backup & read-only export (never restore/wipe that could bypass lock, only backup creation & download)
  if (pathname === "/api/backup" || pathname === "/api/backup/export") {
    return isRead || upperMethod === "POST";
  }
  if (pathname.startsWith("/api/data/exports") && isRead) return true;

  // 4. Local audit log inspection (read-only)
  if ((pathname === "/api/audit-log" || pathname.startsWith("/api/audit-log/")) && isRead) {
    return true;
  }

  // 5. Support & bug report read/create when online so Owner can contact support about the lock
  if (
    pathname === "/api/support/tickets" ||
    pathname.startsWith("/api/support/tickets/") ||
    pathname === "/api/bug-report"
  ) {
    return true;
  }

  return false;
}

/** Remote support commands permitted per least-privilege session mode. */
export const REMOTE_SUPPORT_COMMANDS = [
  "inspect_system_diagnostics",
  "inspect_audit_log",
  "inspect_printer_and_hardware_status",
  "inspect_operational_summary",
  "trigger_cloud_revalidation",
  "clear_stuck_print_jobs",
  "run_local_backup_check",
] as const;

export type RemoteSupportCommandType = (typeof REMOTE_SUPPORT_COMMANDS)[number];
export type LocalSupportSessionMode = "read_only" | "controlled" | "recovery_only";

export function isRemoteSupportCommandAllowed(
  mode: LocalSupportSessionMode,
  command: RemoteSupportCommandType,
  installationLocked: boolean,
): boolean {
  // While `locked_invalid`, ONLY `recovery_only` sessions can run, and they may
  // NEVER inspect operational POS summaries or mutate operational queues.
  if (installationLocked && mode !== "recovery_only") return false;

  if (mode === "recovery_only") {
    return (
      command === "inspect_system_diagnostics" ||
      command === "inspect_audit_log" ||
      command === "trigger_cloud_revalidation" ||
      command === "run_local_backup_check"
    );
  }

  const readOnlyCommands = new Set<RemoteSupportCommandType>([
    "inspect_system_diagnostics",
    "inspect_audit_log",
    "inspect_printer_and_hardware_status",
    "inspect_operational_summary",
  ]);
  if (readOnlyCommands.has(command)) return true;

  if (mode === "controlled") {
    return (
      command === "trigger_cloud_revalidation" ||
      command === "clear_stuck_print_jobs" ||
      command === "run_local_backup_check"
    );
  }
  return false;
}

const SECRET_KEY_PATTERN =
  /(password|passphrase|pin|secret|token|cookie|authorization|master[_-]?key|jwt|ciphertext|totp|recovery[_-]?code|api[_-]?key|private[_-]?key|national[_-]?id|card[_-]?number|iban|sheba)/i;

const INLINE_TOKEN_PATTERNS: RegExp[] = [
  /\b(?:OFL1|LOC1|POS1)-[A-Za-z0-9_-]{6,}\b/gi,
  /\bsync_[A-Za-z0-9_-]{8,}\b/gi,
  /\bposk_(?:live|test)_[A-Za-z0-9_-]{6,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:v1|mk1|ek1)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

export function redactSensitiveText(text: string): string {
  let out = text;
  for (const pattern of INLINE_TOKEN_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  out = out.replace(
    /([?&](?:token|key|secret|code|password|auth|access_token)=)[^&\s#]+/gi,
    "$1[REDACTED]",
  );
  return out;
}

/**
 * Deeply redacts credentials, tokens, keys, cookies, passwords, and sensitive
 * fields from diagnostic objects before leaving a Full Offline installation.
 */
export function redactLocalSupportDiagnostics(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redactSensitiveText(value.slice(0, 4000));
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactLocalSupportDiagnostics(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactLocalSupportDiagnostics(entry, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export interface LocalActivationStatusSummary {
  state: LocalActivationState;
  localOperationsReady: boolean;
  headlineFa: string;
  detailFa: string;
  lockReasonFa: string | null;
  connectivityFa: string;
  cloudSupportAvailable: boolean;
}

const LOCK_REASON_LABELS_FA: Record<ConfirmedCloudDenialCode, string> = {
  credential_invalid: "توکن یا اعتبارنامهٔ دستگاه نامعتبر است.",
  credential_revoked: "اعتبارنامهٔ این دستگاه در سرور ابری باطل شده است.",
  device_revoked: "دسترسی این نصب دسکتاپ توسط مالک یا مدیر پلتفرم لغو شده است.",
  device_disabled: "این نصب دسکتاپ در کنسول ابری غیرفعال شده است.",
  business_disabled: "کسب‌وکار در سرور ابری غیرفعال شده است.",
  business_suspended: "حساب کسب‌وکار در سرور ابری تعلیق شده است.",
  business_archived: "کسب‌وکار در سرور ابری بایگانی شده است.",
  business_mismatch: "توکن ارائه‌شده متعلق به کسب‌وکار دیگری است و با این نصب هم‌خوانی ندارد.",
  installation_mismatch: "این اعتبارنامه به شناسهٔ نصب دیگری متصل است.",
  profile_not_allowed: "حالت استقرار کاملاً آفلاین برای این کسب‌وکار مجاز نیست.",
  entitlement_denied: "مجوز یا اشتراک کسب‌وکار در سرور ابری معتبر نیست.",
  offline_lease_expired: "مهلت مجوز کارکرد آفلاین به پایان رسیده یا تغییر ساعت سیستم تشخیص داده شده است؛ برای تمدید به سرور ابری متصل شوید.",
};

export function describeLockReasonFa(code: string | null | undefined): string {
  if (!code) return "اعتبارسنجی کسب‌وکار توسط سرور ابری رد شده است.";
  return (
    LOCK_REASON_LABELS_FA[code as ConfirmedCloudDenialCode] ??
    "اعتبارسنجی کسب‌وکار توسط سرور ابری رد شده است."
  );
}

/**
 * Produces truthful Persian RTL indicators corresponding to Issue #974 §2:
 *   - Local operations ready (`آماده عملیات محلی`)
 *   - Internet offline (`اینترنت قطع است`)
 *   - Cloud unreachable (`سرور ابری در دسترس نیست`)
 *   - Validation pending (`در انتظار اعتبارسنجی ابری`)
 *   - Cloud validation failed (`اعتبارسنجی ابری ناموفق`)
 *   - Business locked (`کسب‌وکار قفل شده است`)
 */
export function deriveLocalActivationStatusSummary(input: {
  state: LocalActivationState;
  lockReason?: string | null;
  lastErrorCode?: string | null;
  cloudReachable: boolean;
  internetHintOffline?: boolean;
}): LocalActivationStatusSummary {
  if (input.state === "locked_invalid") {
    const lockReasonFa = describeLockReasonFa(input.lockReason);
    return {
      state: "locked_invalid",
      localOperationsReady: false,
      headlineFa: "کسب‌وکار قفل شده است",
      detailFa: lockReasonFa,
      lockReasonFa,
      connectivityFa: input.cloudReachable ? "اعتبارسنجی ابری ناموفق" : "سرور ابری در دسترس نیست",
      cloudSupportAvailable: false,
    };
  }

  if (input.state === "not_enrolled") {
    return {
      state: "not_enrolled",
      localOperationsReady: true,
      headlineFa: "در انتظار فعال‌سازی ابری",
      detailFa:
        "این نصب آفلاین هنوز با سرور ابری فعال‌سازی نشده است. داده‌های محلی شما کاملاً محفوظ است؛ برای اعتبارسنجی کسب‌وکار و فعال‌شدن پشتیبانی آنلاین، آدرس سرور ابری و توکن فعال‌سازی را ثبت کنید.",
      lockReasonFa: null,
      connectivityFa: "فعال‌سازی ابری انجام نشده",
      cloudSupportAvailable: false,
    };
  }

  if (input.state === "validating") {
    return {
      state: "validating",
      localOperationsReady: true,
      headlineFa: "در حال اعتبارسنجی ابری",
      detailFa: "در حال بررسی ارتباط امن با سرور ابری؛ عملیات محلی بدون وقفه آماده است.",
      lockReasonFa: null,
      connectivityFa: "در انتظار اعتبارسنجی ابری",
      cloudSupportAvailable: false,
    };
  }

  if (input.state === "validation_pending") {
    const connectivityFa = input.internetHintOffline
      ? "اینترنت قطع است"
      : "سرور ابری در دسترس نیست";
    return {
      state: "validation_pending",
      localOperationsReady: true,
      headlineFa: "آماده عملیات محلی",
      detailFa:
        "عملیات فروش، صندوق و حسابداری محلی بدون وقفه فعال است. اعتبارسنجی دوره‌ای در انتظار برقراری مجدد ارتباط با سرور ابری است.",
      lockReasonFa: null,
      connectivityFa: `${connectivityFa} • در انتظار اعتبارسنجی ابری`,
      cloudSupportAvailable: false,
    };
  }

  // state === "active"
  if (!input.cloudReachable) {
    const connectivityFa = input.internetHintOffline
      ? "اینترنت قطع است"
      : "سرور ابری در دسترس نیست";
    return {
      state: "active",
      localOperationsReady: true,
      headlineFa: "آماده عملیات محلی",
      detailFa:
        "عملیات محلی کاملاً آماده است. برای ارسال تیکت پشتیبانی یا دریافت به‌روزرسانی مشخصات کسب‌وکار، اتصال ابری لازم است.",
      lockReasonFa: null,
      connectivityFa,
      cloudSupportAvailable: false,
    };
  }

  return {
    state: "active",
    localOperationsReady: true,
    headlineFa: "آماده عملیات محلی",
    detailFa: "اعتبارسنجی ابری معتبر است؛ عملیات محلی مستقل است و تراکنش‌های فروش به ابر ارسال نمی‌شوند.",
    lockReasonFa: null,
    connectivityFa: "اتصال ابری معتبر",
    cloudSupportAvailable: true,
  };
}
