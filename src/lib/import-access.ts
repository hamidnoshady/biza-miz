/**
 * The one effective-import-access decision (GitHub #1580 / ESH-227).
 *
 * Importing is a *mutation*, so it may not be decided by "the owner picked the
 * app in the gallery": a selection is a draft, not access. The canonical
 * question is the same one #1041/#1579 already answer for the app itself —
 * *is this service effective right now?* — and this module is the one place
 * that turns it into an import answer. It composes:
 *
 *   - the owner's explicit app selection (`setup.selectedApps`): a selected app
 *     that is not active is `awaiting_activation`, never "allowed";
 *   - the canonical activation state (`business_service_activations`), where a
 *     deliberate customer disable, a suspension or a purge state all refuse;
 *   - an **active complimentary grant** (#1579): a free trial or an indefinite
 *     grant is effective access exactly like a paid activation, so a granted
 *     business imports without a subscription or a funded wallet;
 *   - industry/module applicability, deployment/provider support and the
 *     member's domain permission (supplied by the caller);
 *   - Workspace's own eligibility + service decision (#1110).
 *
 * ## Grandfathering is explicit, never accidental
 *
 * A business that predates the app gallery has no selection record. It keeps
 * the access it has always had — otherwise shipping this rule would lock every
 * existing tenant out of their own transfers. The caller says so with
 * `selection == null`; an *empty* selection is a real answer ("no apps"), not
 * the legacy state.
 *
 * ## Staging is not applying
 *
 * A file can be parsed, mapped and previewed without writing business data, so
 * `stagingAllowed` is separate from `allowed`. A selected-but-unactivated app,
 * a suspension or a retained-but-disabled service may still stage; a purged
 * service or an app that was never selected may not even offer the upload,
 * because there is no destination it could ever apply to.
 *
 * Framework-free on purpose (no `db`, no `next`): the wizard, the API route,
 * the Data Transfer engine and the job worker all import this file, and the
 * unit tests drive the whole matrix without a database.
 */
import type { AppKey } from "./apps";

/** The app/Workspace surface that owns an import target. */
export type ImportServiceKind = "app" | "workspace";

export type ImportAccessReason =
  /** The app was not chosen in the wizard's gallery. */
  | "app_not_selected"
  /** Chosen (or planned) but the paid/complimentary service is not active yet. */
  | "awaiting_activation"
  /** The customer deliberately disabled the service. */
  | "service_disabled"
  /** The service is suspended by billing/platform/legal state. */
  | "service_suspended"
  /** Retention/purge has removed or is removing the destination data. */
  | "service_purged"
  /** A complimentary grant that has expired or been revoked. */
  | "grant_inactive"
  /** No supported import path for this target at all. */
  | "not_importable"
  /** The business type has no such module (a shop has no menu). */
  | "industry_module"
  /** The member lacks the entity's own permission or `data.import`. */
  | "permission"
  /** My Workspace is not available to this business type / service state. */
  | "workspace_unavailable"
  /** This deployment cannot run the owning capability. */
  | "deployment_unsupported"
  /** The operator has switched the owning app off for this tenant. */
  | "app_unavailable";

/** How effective access was established, for the UI and the audit trail. */
export type ImportAccessSource =
  | "paid_active"
  | "complimentary_grant"
  | "legacy_grandfathered";

export interface ImportAccessGrantInput {
  status: "pending" | "active" | "expired" | "revoked";
  startsAt: string;
  /** `null` = an indefinite grant. */
  expiresAt: string | null;
}

export interface ImportAccessWorkspaceInput {
  /** #1110 industry applicability (an approved override may say otherwise). */
  eligible: boolean;
  /** The Workspace service is not deliberately disabled/suspended. */
  serviceEnabled: boolean;
  /** This deployment can run the capability. */
  deploymentSupported: boolean;
}

/**
 * The activation states that mean "there is no usable destination".
 *
 * Kept local rather than imported from the 35 KB service catalogue because
 * this module is on the wizard's client path; `import-access.test.ts` pins the
 * two sets against `SERVICE_STATE_META` so they cannot drift.
 */
export const IMPORT_BLOCKED_ACTIVATION_STATES = [
  "disabled_retained",
  "eligible_for_purge",
  "purging",
  "data_purged",
  "purge_failed",
] as const;

/** Suspension states: data is retained, writes are not authorised. */
export const IMPORT_SUSPENDED_ACTIVATION_STATES = [
  "suspended_insufficient_credit",
  "platform_unavailable",
  "legal_hold",
] as const;

/** States that are "activation is still in progress", not a refusal. */
export const IMPORT_PENDING_ACTIVATION_STATES = [
  "setup_in_progress",
  "payment_reserved",
] as const;

const BLOCKED = new Set<string>(IMPORT_BLOCKED_ACTIVATION_STATES);
const SUSPENDED = new Set<string>(IMPORT_SUSPENDED_ACTIVATION_STATES);
const PENDING = new Set<string>(IMPORT_PENDING_ACTIVATION_STATES);

export interface ImportAccessInput {
  /** The owning app; `null` for a Workspace target. */
  appKey: AppKey | null;
  /**
   * `setup.selectedApps`: `null` = pre-gallery tenant (grandfathered), an array
   * (including `[]`) = an explicit owner choice.
   */
  selection: readonly AppKey[] | null;
  /** Canonical activation state, or `null` when no row exists. */
  activationState: string | null;
  /** The active-grant read for this service, if one exists. */
  grant?: ImportAccessGrantInput | null;
  /** Workspace's #1110 decision; absent for app-owned targets. */
  workspace?: ImportAccessWorkspaceInput | null;
  /** The member holds `data.import` AND the entity's own import permission. */
  permitted: boolean;
  /** The platform has a registered write path for this entity. */
  importable: boolean;
  /** False when the business type has no such module. */
  industryEligible?: boolean;
  /** Deployment/provider support for the target's owner. Defaults to true. */
  deploymentSupported?: boolean;
  /** The instant the decision is made (tests pass it; callers default to now). */
  at?: string;
}

export interface ImportAccessDecision {
  /** A write/apply may be performed now. */
  allowed: boolean;
  /** Parsing, mapping and a no-write preview may be offered. */
  stagingAllowed: boolean;
  reason: ImportAccessReason | null;
  /** Persian, owner-facing explanation. Null when allowed. */
  label: string | null;
  source: ImportAccessSource | null;
}

/** A grant is effective only inside its own window. */
export function activeGrantAt(
  grant: ImportAccessGrantInput | null | undefined,
  atIso: string,
): boolean {
  if (!grant || grant.status !== "active") return false;
  const at = Date.parse(atIso);
  const starts = Date.parse(grant.startsAt);
  if (Number.isFinite(starts) && starts > at) return false;
  if (grant.expiresAt === null) return true;
  const expires = Date.parse(grant.expiresAt);
  return Number.isFinite(expires) ? expires > at : false;
}

function denied(
  reason: ImportAccessReason,
  label: string,
  stagingAllowed: boolean,
): ImportAccessDecision {
  return { allowed: false, stagingAllowed, reason, label, source: null };
}

function granted(source: ImportAccessSource): ImportAccessDecision {
  return {
    allowed: true,
    stagingAllowed: true,
    reason: null,
    label: null,
    source,
  };
}

/**
 * Decide whether an import target may be written (and whether it may at least
 * be staged in the wizard).
 *
 * Order is deliberate: "this cannot be imported at all" outranks "the app is
 * not selected", because sending an owner to select an app that still would
 * not unlock the target is a false promise.
 */
export function resolveImportAccess(
  input: ImportAccessInput,
): ImportAccessDecision {
  if (!input.importable) {
    return denied(
      "not_importable",
      "ورود این نوع داده از فایل پشتیبانی نمی‌شود؛ آن را از صفحهٔ خودش ثبت کنید.",
      false,
    );
  }
  if (input.industryEligible === false) {
    return denied(
      "industry_module",
      "این نوع داده با نوع کسب‌وکار شما سازگار نیست؛ در این صنف وجود ندارد.",
      false,
    );
  }
  if (!input.permitted) {
    return denied(
      "permission",
      "برای ورود این داده، مجوز «ورود داده» و دسترسی همان بخش لازم است.",
      false,
    );
  }

  const at = input.at ?? new Date().toISOString();

  // ---- My Workspace: eligibility + its own service, never an APP_KEY ------
  if (input.appKey === null) {
    const workspace = input.workspace;
    if (!workspace || !workspace.eligible) {
      return denied(
        "workspace_unavailable",
        "«میز کار من» برای نوع کسب‌وکار شما فعال نیست؛ ورود پروژه، کار و قرارداد در دسترس نیست.",
        false,
      );
    }
    if (!workspace.deploymentSupported) {
      return denied(
        "deployment_unsupported",
        "این نسخه از استقرار، «میز کار من» را اجرا نمی‌کند؛ آماده‌سازی فایل ممکن است اما ورود انجام نمی‌شود.",
        true,
      );
    }
    if (!workspace.serviceEnabled) {
      return denied(
        "awaiting_activation",
        "سرویس «میز کار من» فعال نیست؛ پس از فعال‌سازی می‌توانید داده وارد کنید.",
        true,
      );
    }
    if (input.activationState && BLOCKED.has(input.activationState)) {
      return denied(
        "service_purged",
        "داده‌های «میز کار من» در حال پاک‌سازی یا پاک‌شده است.",
        false,
      );
    }
    if (input.activationState && SUSPENDED.has(input.activationState)) {
      return denied(
        "service_suspended",
        "سرویس «میز کار من» متوقف است؛ پیش‌نمایش ممکن است اما ورود اطلاعات انجام نمی‌شود.",
        true,
      );
    }
    return granted("paid_active");
  }

  // ---- App-owned target ---------------------------------------------------
  if (input.selection != null && !input.selection.includes(input.appKey)) {
    return denied(
      "app_not_selected",
      "برنامهٔ صاحب این داده انتخاب نشده است؛ ابتدا آن را در مرحلهٔ انتخاب برنامه‌ها انتخاب کنید.",
      false,
    );
  }

  if (input.deploymentSupported === false) {
    return denied(
      "app_unavailable",
      "این برنامه در حال حاضر در دسترس نیست؛ می‌توانید فایل را آماده کنید اما ورود تا فعال‌شدن آن انجام نمی‌شود.",
      true,
    );
  }

  const state = input.activationState;
  if (state && BLOCKED.has(state)) {
    return denied(
      "service_disabled",
      "سرویس این داده غیرفعال شده و داده‌های آن در حال پاک‌سازی است.",
      false,
    );
  }
  if (state && SUSPENDED.has(state)) {
    return denied(
      "service_suspended",
      "سرویس این داده متوقف است؛ پیش‌نمایش ممکن است اما ورود اطلاعات انجام نمی‌شود.",
      true,
    );
  }
  if (state && PENDING.has(state)) {
    return denied(
      "awaiting_activation",
      "منتظر فعال‌سازی: می‌توانید فایل را آماده و پیش‌نمایش کنید؛ ورود پس از فعال‌سازی انجام می‌شود.",
      true,
    );
  }

  if (state === "active") {
    return granted("paid_active");
  }

  // No activation row: a #1579 grant is effective access; a pre-gallery tenant
  // keeps its historic access; an explicitly selected app is not yet active.
  if (activeGrantAt(input.grant, at)) {
    return granted("complimentary_grant");
  }
  if (input.grant) {
    // A grant row that is not effective (expired, revoked, pending, or an
    // active row whose window already closed) is a definite "no", not a reason
    // to fall back to grandmothering.
    return denied(
      "grant_inactive",
      "دورهٔ رایگان این سرویس به پایان رسیده یا لغو شده است؛ برای ورود، سرویس را فعال کنید.",
      true,
    );
  }
  if (input.selection == null) {
    return granted("legacy_grandfathered");
  }
  return denied(
    "awaiting_activation",
    "منتظر فعال‌سازی: می‌توانید فایل را آماده و پیش‌نمایش کنید؛ ورود پس از فعال‌سازی انجام می‌شود.",
    true,
  );
}
