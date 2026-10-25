/**
 * Issue #1115 §A.2 — may the Cloud enrol a new Windows Hybrid install for this
 * business and branch *right now*?
 *
 * "The company exists" is not "the company is configured". Before a device is
 * reserved or a code consumed, the Cloud answers from persisted state — never
 * from a progress marker and never from a request body — and when the answer is
 * no it says which prerequisite is missing and where to fix it, so the desktop
 * can show «کسب‌وکار خود را ابتدا در ابر کامل کنید» with an action, pause, and
 * resume when the answer turns yes.
 *
 * This module is the pure decision. It reads nothing; the service
 * (`desktop-enrollment-readiness-service.ts`) gathers the facts and the route
 * serves the result. It reuses, and never re-derives:
 *
 *  - `setupReadiness()` — the per-industry required wizard prerequisites;
 *  - `progress.completedAt` — the one canonical completion marker (#808 §1).
 *
 * Only Cloud prerequisites are required. Printers, hardware, backup and
 * opening balances are optional wizard steps and never block enrolment; they
 * can be configured on the Windows machine later.
 *
 * Pure and client-safe (no database, no Next imports).
 */
import { LEGACY_PAIRING_SNAPSHOT_VERSION } from "./pairing-snapshot";
import type { SetupReadiness } from "./setup-readiness";
import type { WizardStep } from "./wizard-steps";

export type EnrollmentBlockerCode =
  | "business_not_found"
  | "business_suspended"
  | "business_archived"
  | "no_active_owner"
  | "not_entitled"
  | "no_active_location"
  | "location_required"
  | "location_unavailable"
  | "setup_incomplete"
  | "setup_not_completed"
  | "branch_menu_empty"
  | "no_payment_way"
  | "client_outdated";

export type EnrollmentAction =
  /** Send the owner into the Cloud setup wizard, at the first missing step when one is known. */
  | { kind: "open_cloud_setup"; href: string }
  /** More than one active branch and none (or an unusable one) was chosen. */
  | { kind: "choose_location"; locations: readonly { id: string; name: string }[] }
  /** The Windows app must be updated before it can enrol. */
  | { kind: "update_desktop" }
  /** Only the platform operator can lift it. */
  | { kind: "contact_support" };

export interface EnrollmentBlocker {
  code: EnrollmentBlockerCode;
  /** Owner-facing Persian message. */
  message: string;
  action: EnrollmentAction;
  /** For `setup_incomplete`: the required wizard steps still missing, in wizard order. */
  missingSteps?: readonly string[];
}

export interface EnrollmentFacts {
  business: {
    exists: boolean;
    status: "active" | "suspended" | "archived" | null;
  };
  setup: SetupReadiness;
  /** `progress.completedAt`: the deliberate Finish transition, not readiness. */
  setupCompletedAt: string | null;
  /** Active users whose role is owner. */
  activeOwners: number;
  activeLocations: readonly { id: string; name: string }[];
  /** The branch the desktop asked to be enrolled at, if it named one. */
  requestedLocationId: string | null;
  /**
   * Active menu items per active branch id, or null when this industry's wizard
   * has no menu step. `setupReadiness` counts the whole business; a till at an
   * empty branch would open with nothing to sell.
   */
  sellableMenuItemsByLocation: Readonly<Record<string, number>> | null;
  /** Active payment ways the business offers. */
  activePaymentWays: number;
  /** The `site_cloud_sync` entitlement (also what `/api/server-sync` is gated on). */
  siteCloudSyncEntitled: boolean;
  /** The newest pairing snapshot the Windows client says it can read, if it said. */
  clientMaxSnapshotVersion: number | null;
}

export interface EnrollmentCheck {
  id: string;
  ok: boolean;
}

export interface EnrollmentReadiness {
  ready: boolean;
  /** The branch that will be enrolled: the requested one, or the only active one. */
  locationId: string | null;
  blockers: readonly EnrollmentBlocker[];
  /** Every check made, passing or not, so a client can show a full list. */
  checks: readonly EnrollmentCheck[];
  /** Stable, sorted: a client resumes by watching this change, not by polling a fake percentage. */
  blockerCodes: readonly EnrollmentBlockerCode[];
}

/** The wizard page for a step id (`aec_profile` → `/setup/aec-profile`). */
export function setupStepHref(step: WizardStep | string): string {
  return `/setup/${step.replace(/_/g, "-")}`;
}

const MESSAGES: Record<EnrollmentBlockerCode, string> = {
  business_not_found: "کسب‌وکاری برای این حساب پیدا نشد.",
  business_suspended: "حساب کسب‌وکار در حال حاضر تعلیق است و اتصال دستگاه جدید ممکن نیست.",
  business_archived: "این کسب‌وکار بایگانی شده است و اتصال دستگاه جدید ممکن نیست.",
  no_active_owner: "کسب‌وکار مالک فعال ندارد؛ پیش از اتصال دستگاه باید یک مالک فعال وجود داشته باشد.",
  not_entitled: "اتصال دستگاه دسکتاپ (همگام‌سازی ابری) برای این کسب‌وکار فعال نیست.",
  no_active_location: "کسب‌وکار هیچ شعبهٔ فعالی ندارد.",
  location_required: "کسب‌وکار چند شعبه دارد؛ شعبه‌ای را که این دستگاه به آن وصل می‌شود انتخاب کنید.",
  location_unavailable: "شعبهٔ انتخاب‌شده وجود ندارد یا غیرفعال است.",
  setup_incomplete: "کسب‌وکار خود را ابتدا در ابر کامل کنید.",
  setup_not_completed: "راه‌اندازی در ابر هنوز با گام «پایان» نهایی نشده است.",
  branch_menu_empty: "شعبهٔ انتخاب‌شده هنوز هیچ آیتم فعال و قابل فروش در منو ندارد.",
  no_payment_way: "هیچ روش پرداخت فعالی تعریف نشده است.",
  client_outdated: "نسخهٔ برنامهٔ ویندوز قدیمی است؛ ابتدا آن را به‌روزرسانی کنید.",
};

/** Decide readiness from facts. Never throws and never reads anything else. */
export function evaluateEnrollmentReadiness(facts: EnrollmentFacts): EnrollmentReadiness {
  const blockers: EnrollmentBlocker[] = [];
  const checks: EnrollmentCheck[] = [];
  const add = (blocker: EnrollmentBlocker) => blockers.push(blocker);
  const check = (id: string, ok: boolean) => checks.push({ id, ok });
  const contactSupport: EnrollmentAction = { kind: "contact_support" };

  // 1. The business itself. Nothing below is meaningful without one.
  const businessOk = facts.business.exists;
  check("business", businessOk);
  if (!businessOk) {
    add({ code: "business_not_found", message: MESSAGES.business_not_found, action: contactSupport });
    return finish(blockers, checks, null);
  }
  const statusOk = facts.business.status === "active" || facts.business.status === null;
  check("business_active", statusOk);
  if (facts.business.status === "suspended") {
    add({ code: "business_suspended", message: MESSAGES.business_suspended, action: contactSupport });
  } else if (facts.business.status === "archived") {
    add({ code: "business_archived", message: MESSAGES.business_archived, action: contactSupport });
  }

  // 2. A person who can sign in and answer for the business.
  check("owner", facts.activeOwners > 0);
  if (facts.activeOwners < 1) {
    add({ code: "no_active_owner", message: MESSAGES.no_active_owner, action: contactSupport });
  }

  // 3. Entitlement for what is being enrolled.
  check("entitlement", facts.siteCloudSyncEntitled);
  if (!facts.siteCloudSyncEntitled) {
    add({ code: "not_entitled", message: MESSAGES.not_entitled, action: contactSupport });
  }

  // 4. The branch. One active branch is chosen for the owner; several need a choice.
  const locations = facts.activeLocations;
  let locationId: string | null = null;
  check("location", locations.length > 0);
  if (locations.length === 0) {
    add({ code: "no_active_location", message: MESSAGES.no_active_location, action: { kind: "open_cloud_setup", href: setupStepHref("business") } });
  } else if (facts.requestedLocationId) {
    const chosen = locations.find((location) => location.id === facts.requestedLocationId);
    if (chosen) locationId = chosen.id;
    else {
      add({
        code: "location_unavailable",
        message: MESSAGES.location_unavailable,
        action: { kind: "choose_location", locations },
      });
    }
  } else if (locations.length === 1) {
    locationId = locations[0].id;
  } else {
    add({ code: "location_required", message: MESSAGES.location_required, action: { kind: "choose_location", locations } });
  }
  check("location_chosen", locationId !== null);

  // 5. Required setup. Readiness is derived from persisted data; completion is
  //    the deliberate Finish. A business can be "ready" and not yet finished, and
  //    the owner must be sent to finish it, not to redo what is already there.
  const missing = Object.entries(facts.setup.steps)
    .filter(([, satisfied]) => !satisfied)
    .map(([step]) => step);
  check("setup_ready", facts.setup.ready);
  if (!facts.setup.ready) {
    add({
      code: "setup_incomplete",
      message: MESSAGES.setup_incomplete,
      action: { kind: "open_cloud_setup", href: setupStepHref(missing[0] ?? "business") },
      missingSteps: missing,
    });
  }
  const completed = facts.setupCompletedAt !== null;
  check("setup_completed", completed);
  if (facts.setup.ready && !completed) {
    add({ code: "setup_not_completed", message: MESSAGES.setup_not_completed, action: { kind: "open_cloud_setup", href: "/setup/finish" } });
  }

  // 6. What a till needs that the business-wide readiness does not prove.
  if (facts.sellableMenuItemsByLocation !== null && locationId !== null) {
    const ok = (facts.sellableMenuItemsByLocation[locationId] ?? 0) > 0;
    check("branch_menu", ok);
    if (!ok) {
      add({ code: "branch_menu_empty", message: MESSAGES.branch_menu_empty, action: { kind: "open_cloud_setup", href: setupStepHref("menu") } });
    }
  }
  check("payment_way", facts.activePaymentWays > 0);
  if (facts.activePaymentWays < 1) {
    add({ code: "no_payment_way", message: MESSAGES.no_payment_way, action: { kind: "open_cloud_setup", href: "/settings/payment-methods" } });
  }

  // 7. Protocol compatibility, only when the client said what it can read.
  if (facts.clientMaxSnapshotVersion !== null) {
    const ok = facts.clientMaxSnapshotVersion >= LEGACY_PAIRING_SNAPSHOT_VERSION;
    check("client_protocol", ok);
    if (!ok) add({ code: "client_outdated", message: MESSAGES.client_outdated, action: { kind: "update_desktop" } });
  }

  return finish(blockers, checks, locationId);
}

function finish(
  blockers: EnrollmentBlocker[],
  checks: EnrollmentCheck[],
  locationId: string | null,
): EnrollmentReadiness {
  return {
    ready: blockers.length === 0,
    locationId,
    blockers,
    checks,
    blockerCodes: [...new Set(blockers.map((blocker) => blocker.code))].sort(),
  };
}
