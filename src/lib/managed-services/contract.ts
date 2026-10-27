/**
 * Issue #902 — the platform-wide managed-service contract.
 *
 * Every third-party integration in this product is a **Bizamiz managed
 * service**. A tenant buys, switches on and uses a first-party capability
 * (messaging, marketplaces, payments, media, AI) inside the app that owns it.
 * Bizamiz holds the supplier relationship, the credentials, the wholesale
 * tariff and the operational dashboards. The tenant holds one thing: the
 * platform wallet, priced at the retail rate.
 *
 * That is a product rule, not a Kavenegar implementation detail, so it lives
 * here rather than inside an adapter. Two things follow from it, and this file
 * is both of them:
 *
 *   1. **A vocabulary for what a tenant may see.** `TenantManagedServiceView`
 *      is the only shape a tenant-facing surface may render about a managed
 *      service: a first-party label, one of four readiness states, a Persian
 *      sentence, and (when the tenant can act) a link to the first-party screen
 *      that fixes it. There is deliberately no field for a provider name, a
 *      provider account id, a credential hint, a wholesale price or a provider
 *      status code — a shape that cannot carry a leak is cheaper to keep honest
 *      than a promise that nobody will put one there.
 *
 *   2. **A guardrail that fails CI, not the customer.** `findTenantLeaks`
 *      walks a response object and reports the keys and values that describe a
 *      supplier. `assertTenantSafePayload` throws on them; the unit test beside
 *      this file proves both. The same vocabulary is what a future managed
 *      integration (#894 Torob, #896 Divar, payment/media/AI follow-ups)
 *      registers itself in, so a new adapter inherits the contract instead of
 *      re-deriving it.
 *
 * The commercial rule is equally load-bearing and stated once here: a managed
 * service never creates a second wallet. Retail charges go through the central
 * billing domain (`wallet_ledger`, price versions, holds/settles and
 * `billing_vendor_cost_events`); wholesale/provider credit is internal
 * pre-funding that no tenant endpoint may report.
 */

import type { AppKey } from "../apps";

/** The four states a tenant is ever shown. Nothing else reaches a tenant UI. */
export type ManagedServiceStatus = "ready" | "preparing" | "action_required" | "unavailable";

/** Persian labels — first-party wording; no supplier vocabulary. */
export const MANAGED_SERVICE_STATUS_LABELS: Record<ManagedServiceStatus, string> = {
  ready: "آماده",
  preparing: "در حال آماده‌سازی",
  action_required: "نیازمند اقدام",
  unavailable: "غیرفعال",
};

/**
 * Where a tenant-facing action may send someone. Anonymous strings are not
 * allowed: a managed service can only link to a first-party surface the
 * platform already owns.
 */
export type ManagedServiceActionHref =
  | "/settings/billing"
  | "/growth/settings"
  | "/support"
  | "/dashboard";

export interface ManagedServiceAction {
  label: string;
  href: ManagedServiceActionHref;
  /**
   * True only while this status blocks the service entirely. A tenant-facing
   * screen may hide the service's controls when `blocking`, and should keep
   * them visible (disabled, with the detail) otherwise.
   */
  blocking: boolean;
}

/**
 * One managed service's definition. Provider choice is *not* part of it: a
 * provider is swapped behind the adapter, and nothing a tenant renders changes.
 */
export interface ManagedServiceDefinition {
  /** Stable internal key, e.g. "messaging.sms". */
  key: string;
  /** First-party name shown to tenants, e.g. «پیامک». */
  tenantLabel: string;
  /** The app whose workflows own the capability. */
  owningApp: AppKey;
  /** Entitlement capability that decides whether the business may use it. */
  capability: string;
  /**
   * Persian one-liner for the ordinary, working case. Rendered under the label;
   * never mentions a supplier.
   */
  readyDetail: string;
}

/**
 * The managed-service registry.
 *
 * Add an entry when a provider-backed capability becomes a managed service.
 * The entry is metadata only — it must not describe the vendor, because
 * everything in this object is safe to hand to a tenant screen.
 */
export const MANAGED_SERVICES = {
  messagingSms: {
    key: "messaging.sms",
    tenantLabel: "پیامک",
    owningApp: "growth",
    capability: "cloud.messaging",
    readyDetail: "ارسال پیامک از اعتبار پلتفرم انجام می‌شود.",
  },
  messagingEmail: {
    key: "messaging.email",
    tenantLabel: "ایمیل",
    owningApp: "growth",
    capability: "cloud.messaging",
    readyDetail: "ارسال ایمیل از اعتبار پلتفرم انجام می‌شود.",
  },
} as const satisfies Record<string, ManagedServiceDefinition>;

export type ManagedServiceKey = (typeof MANAGED_SERVICES)[keyof typeof MANAGED_SERVICES]["key"];

/**
 * The tenant-facing readiness payload. Every field is safe to serialise into a
 * `/api/...` response or render in a dashboard card.
 */
export interface TenantManagedServiceView {
  /** Internal service key — stable across provider changes. */
  service: string;
  label: string;
  status: ManagedServiceStatus;
  /** Persian label matching `status`, shipped so the client never maps codes. */
  statusLabel: string;
  /** Persian explanation of the current state. */
  detail: string;
  /** Present only when the tenant can do something about it. */
  action: ManagedServiceAction | null;
  /** True when the platform will retry by itself; the tenant should wait. */
  retryable: boolean;
  /** When the state was last established, ISO-8601 (wire format, not display). */
  checkedAt: string | null;
}

/**
 * Internal reasons a managed service is not simply ready, in the only
 * vocabulary the adapter may hand to the contract layer.
 *
 * These are deliberately provider-free: an adapter translates its supplier's
 * error codes into one of these, and the contract picks the sentence. That
 * indirection is what keeps a provider code from ever becoming tenant copy.
 */
export type ManagedServiceDetailKey =
  | "ready"
  | "provisioning"
  | "suspended_by_plan"
  | "suspended_by_platform"
  | "wallet_empty"
  | "platform_setup_incomplete"
  | "temporarily_unavailable"
  | "needs_support";

/** Persian tenant copy for each internal reason. */
export const MANAGED_SERVICE_DETAILS: Record<ManagedServiceDetailKey, string> = {
  ready: "سرویس فعال است و آمادهٔ استفاده است.",
  provisioning: "سرویس در حال آماده‌سازی است و به‌صورت خودکار فعال می‌شود.",
  suspended_by_plan: "برای استفاده از این سرویس، اشتراک یا طرح کسب‌وکار را فعال کنید.",
  suspended_by_platform: "این سرویس موقتاً توسط پشتیبانی پلتفرم غیرفعال شده است.",
  wallet_empty: "اعتبار پلتفرم کافی نیست؛ کیف پول را شارژ کنید.",
  platform_setup_incomplete: "سرویس هنوز در حال راه‌اندازی است؛ نیازی به اقدام شما نیست.",
  temporarily_unavailable: "سرویس موقتاً در دسترس نیست؛ به‌صورت خودکار دوباره بررسی می‌شود.",
  needs_support: "برای ادامهٔ استفاده از این سرویس با پشتیبانی تماس بگیرید.",
};

/**
 * Turn internal readiness into the one shape a tenant surface may render.
 *
 * The mapping is explicit rather than computed so a new internal state is a
 * type error here instead of an accidental raw state on screen.
 */
export function toTenantManagedServiceView(input: {
  definition: ManagedServiceDefinition;
  detailKey: ManagedServiceDetailKey;
  checkedAt?: Date | string | null;
  /** Overrides the state derived from `detailKey` (e.g. a degraded-but-usable service). */
  status?: ManagedServiceStatus;
}): TenantManagedServiceView {
  const { definition, detailKey } = input;
  const status = input.status ?? statusForDetail(detailKey);
  const checkedAt =
    input.checkedAt instanceof Date
      ? input.checkedAt.toISOString()
      : typeof input.checkedAt === "string"
        ? input.checkedAt
        : null;
  return {
    service: definition.key,
    label: definition.tenantLabel,
    status,
    statusLabel: MANAGED_SERVICE_STATUS_LABELS[status],
    detail: detailKey === "ready" ? definition.readyDetail : MANAGED_SERVICE_DETAILS[detailKey],
    action: actionForDetail(detailKey),
    retryable: detailKey === "provisioning" || detailKey === "temporarily_unavailable",
    checkedAt,
  };
}

/** The readiness state implied by an internal reason. */
export function statusForDetail(detailKey: ManagedServiceDetailKey): ManagedServiceStatus {
  switch (detailKey) {
    case "ready":
      return "ready";
    case "provisioning":
      return "preparing";
    case "wallet_empty":
    case "suspended_by_plan":
    case "needs_support":
      return "action_required";
    case "suspended_by_platform":
    case "platform_setup_incomplete":
    case "temporarily_unavailable":
      return "unavailable";
  }
}

/** The first-party destination for a reason, when one exists. */
export function actionForDetail(detailKey: ManagedServiceDetailKey): ManagedServiceAction | null {
  switch (detailKey) {
    case "wallet_empty":
      return { label: "شارژ کیف پول", href: "/settings/billing", blocking: true };
    case "suspended_by_plan":
      return { label: "مشاهدهٔ طرح و اشتراک", href: "/settings/billing", blocking: true };
    case "needs_support":
      return { label: "تماس با پشتیبانی", href: "/support", blocking: true };
    default:
      return null;
  }
}

/**
 * Internal fault taxonomy for a managed operation (send, provision, fund).
 *
 * `operatorDetail` is English and lives only in logs/console: it exists so an
 * engineer can diagnose the supplier without the supplier's vocabulary
 * crossing into a tenant response. `tenantMessage` is what a person may read.
 */
export type ManagedServiceFaultCode =
  | "service_not_ready"
  | "service_suspended"
  | "recipient_invalid"
  | "content_blocked"
  | "platform_credit_exhausted"
  | "rate_limited"
  | "timeout"
  | "provider_rejected"
  | "unknown";

export interface ManagedServiceFault {
  code: ManagedServiceFaultCode;
  tenantMessage: string;
  operatorDetail: string;
  retryable: boolean;
}

export const MANAGED_SERVICE_FAULTS: Record<ManagedServiceFaultCode, Omit<ManagedServiceFault, "operatorDetail">> = {
  service_not_ready: {
    code: "service_not_ready",
    tenantMessage: "سرویس پیام‌رسانی هنوز آماده نیست؛ به‌زودی فعال می‌شود.",
    retryable: true,
  },
  service_suspended: {
    code: "service_suspended",
    tenantMessage: "ارسال پیام برای این کسب‌وکار موقتاً غیرفعال است.",
    retryable: false,
  },
  recipient_invalid: {
    code: "recipient_invalid",
    tenantMessage: "شمارهٔ گیرنده نامعتبر است.",
    retryable: false,
  },
  content_blocked: {
    code: "content_blocked",
    tenantMessage: "متن پیام شامل عبارت مسدود است.",
    retryable: false,
  },
  platform_credit_exhausted: {
    code: "platform_credit_exhausted",
    tenantMessage: "اعتبار پلتفرم برای ارسال کافی نیست؛ کیف پول را شارژ کنید.",
    retryable: false,
  },
  rate_limited: {
    code: "rate_limited",
    tenantMessage: "محدودیت تعداد ارسال فعال شد؛ کمی بعد دوباره تلاش می‌شود.",
    retryable: true,
  },
  timeout: {
    code: "timeout",
    tenantMessage: "سرویس ارسال به‌موقع پاسخ نداد؛ دوباره تلاش می‌شود.",
    retryable: true,
  },
  provider_rejected: {
    code: "provider_rejected",
    tenantMessage: "سرویس ارسال درخواست را نپذیرفت.",
    retryable: false,
  },
  unknown: {
    code: "unknown",
    tenantMessage: "ارسال انجام نشد؛ کمی بعد دوباره تلاش کنید.",
    retryable: false,
  },
};

export function managedServiceFault(
  code: ManagedServiceFaultCode,
  operatorDetail: string,
): ManagedServiceFault {
  return { ...MANAGED_SERVICE_FAULTS[code], operatorDetail };
}

// ---------------------------------------------------------------------------
// Leak guardrail
// ---------------------------------------------------------------------------

/**
 * Field names that describe the supplier rather than the service.
 *
 * The list is intentionally about *meaning*, not one vendor: `apiKey`,
 * `remaincredit` and `pricingname` are Kavenegar's spellings today, and a
 * different adapter's `access_token`/`balance`/`plan` variants are caught by
 * the generic entries. A tenant payload carrying any of these is a bug even
 * when the value looks harmless.
 */
export const TENANT_FORBIDDEN_FIELDS: readonly string[] = [
  "apikey",
  "api_key",
  "api_key_enc",
  "api_key_hint",
  "childcredit",
  "child_credit",
  "provider",
  "providerkey",
  "provider_key",
  "provider_account_id",
  "vendor",
  "wholesale",
  "wholesale_cost",
  "remaincredit",
  "pricingname",
  "smsfarsicost",
  "smsenglishcost",
  "localid",
  "planid",
  "mininumallowedcredit",
  "password",
  "pwdhashed",
  "renewkey",
  "chargecredit",
];

/**
 * Supplier names that must not appear in tenant-facing values (copy, error
 * messages, download cells). Matched case-insensitively.
 *
 * `kaveh`/`kavenegar` covers the Persian spellings «کاوه‌نگار» and «کاوه نگار»
 * as well; the pattern is intentionally narrow so ordinary words are not
 * flagged by accident.
 */
export const TENANT_PROVIDER_NAME_PATTERN =
  /kavenegar|kaveh\s*-?\s*negar|کاوه\s*-?\s*نگار|kavehnegar/i;

export interface TenantLeak {
  /** Dotted path to the offending entry, e.g. `config.provider`. */
  path: string;
  reason: "forbidden_field" | "provider_name" | "credential_value";
  /** The value, truncated — enough to find it, never a full secret. */
  sample: string;
}

/** A conservative credential shape: long unbroken token-looking strings. */
const CREDENTIAL_VALUE = /\b[A-Za-z0-9]{24,}\b/;

/**
 * Walk a payload and report everything a tenant must not receive.
 *
 * Returns an empty array for a clean payload. Callers use this in tests and at
 * API boundaries (`assertTenantSafePayload`) rather than on every response —
 * the point is that a leak becomes a failing check, not a silent mistake.
 */
export function findTenantLeaks(value: unknown, path = ""): TenantLeak[] {
  const leaks: TenantLeak[] = [];

  const visit = (node: unknown, here: string) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      const name = here.split(".").pop() ?? "";
      if (TENANT_PROVIDER_NAME_PATTERN.test(node)) {
        leaks.push({ path: here, reason: "provider_name", sample: sample(node) });
      }
      if (
        CREDENTIAL_VALUE.test(node) &&
        !/^[0-9a-f-]{36}$/i.test(node) &&
        !/^[0-9a-f]{8,}$/i.test(node) &&
        !name.toLowerCase().includes("service")
      ) {
        leaks.push({ path: here, reason: "credential_value", sample: sample(node) });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${here}[${index}]`));
      return;
    }
    if (typeof node === "object") {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const childPath = here ? `${here}.${key}` : key;
        if (TENANT_FORBIDDEN_FIELDS.includes(key.toLowerCase())) {
          leaks.push({
            path: childPath,
            reason: "forbidden_field",
            sample: typeof child === "string" ? sample(child) : typeof child,
          });
          // Keep walking: a forbidden object may carry more than one problem.
        } else if (TENANT_PROVIDER_NAME_PATTERN.test(key)) {
          // A field named after the supplier (`kavenegarSender`) is a leak even
          // when its value is a harmless line number: the name is what tells a
          // tenant which vendor runs the backend.
          leaks.push({ path: childPath, reason: "provider_name", sample: key });
        }
        visit(child, childPath);
      }
    }
  };

  visit(value, path);
  return leaks;
}

export class ManagedServiceLeakError extends Error {
  readonly leaks: TenantLeak[];

  constructor(leaks: TenantLeak[]) {
    super(`tenant payload leaks provider detail: ${leaks.map((leak) => leak.path).join(", ")}`);
    this.name = "ManagedServiceLeakError";
    this.leaks = leaks;
  }
}

/** Throw when a payload carries provider detail. Use at tenant response edges. */
export function assertTenantSafePayload<T>(payload: T): T {
  const leaks = findTenantLeaks(payload);
  if (leaks.length > 0) throw new ManagedServiceLeakError(leaks);
  return payload;
}

/**
 * Redact provider detail from a string that is about to be logged or shown to
 * an operator. Not a substitute for not building such a string; it is the
 * backstop for a provider's own message arriving inside an error.
 */
export function redactManagedServiceText(text: string): string {
  return text
    .replace(/\/v1\/[^/\s]+/g, "/v1/REDACTED")
    .replace(/([?&](?:apikey|api_key|password|token|localid)=)[^&\s]*/gi, "$1REDACTED")
    .replace(TENANT_PROVIDER_NAME_PATTERN, "سرویس پیام‌رسانی");
}

function sample(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 4)}…${value.slice(-2)}`;
}
