/**
 * The first-run import step's vocabulary — pure, client-safe, no database.
 *
 * `ورود اطلاعات اولیه` is a *step* of the existing setup wizard (issue #1535 /
 * ESH-218), not a second importer. The engine that parses, maps, validates,
 * previews, reconciles and applies belongs to `src/lib/data-transfer/*`; this
 * module only answers the onboarding questions around it:
 *
 *  - which registered data types this business may import right now, and why
 *    one it cannot see is unavailable (an unselected app, a missing permission,
 *    or no supported import path at all);
 *  - how a stored import job maps onto a truthful onboarding state, so Finish
 *    and the dashboard never call a staged or partial import "done";
 *  - the counts the review screens summarise.
 *
 * Keeping it pure is what lets the wizard page, the Finish page, the dashboard
 * notice and their tests share one answer without pulling `pg` into a bundle.
 */
import { APPS, type AppKey } from "./apps";
import {
  DATA_MODULE_LABELS,
  type DataModuleKey,
  type ImportJobStatus,
} from "./data-transfer/types";

/**
 * Which app owns a data-transfer module.
 *
 * Sales/POS, inventory and accounting are work areas of the Accounting app
 * (`docs/architecture/app-boundaries.md`); CRM and Website own their modules.
 * `workspace` is a shared utility (projects, tasks, documents) rather than one
 * of the four billable apps, so it is available whatever was selected.
 */
export const SETUP_IMPORT_MODULE_APP: Record<DataModuleKey, AppKey | null> = {
  accounting: "accounting",
  inventory: "accounting",
  pos: "accounting",
  crm: "crm",
  website: "website",
  workspace: null,
};

export type SetupImportUnavailableReason =
  | "app_not_selected"
  | "permission"
  | "not_importable"
  | "industry_module";

/** One registered entity, reduced to what the onboarding decision needs. */
export interface SetupImportEntityInput {
  key: string;
  module: DataModuleKey;
  label: string;
  description: string;
  /** The platform has a registered write path for this entity. */
  importable: boolean;
  /** This member holds the entity's own import permission and `data.import`. */
  granted: boolean;
  /**
   * False when the entity needs a module this business type does not have —
   * menu categories/items/modifiers for a shop, a service company or AEC.
   * Absent = eligible, which is what every established catalogued type is.
   */
  industryEligible?: boolean;
}

export interface SetupImportCandidate extends SetupImportEntityInput {
  moduleLabel: string;
  appKey: AppKey | null;
  appLabel: string | null;
  available: boolean;
  reason: SetupImportUnavailableReason | null;
  reasonLabel: string | null;
}

function appLabel(key: AppKey | null): string | null {
  if (!key) return null;
  return APPS.find((app) => app.key === key)?.label ?? null;
}

/**
 * Why a registered type cannot be imported in this wizard *right now*.
 *
 * Order matters: "this build cannot import it" is a more fundamental fact than
 * "the app is not selected", and saying the first avoids sending the owner to
 * select an app that still would not unlock the type.
 */
export function setupImportUnavailableReason(
  entity: SetupImportEntityInput,
  selectedApps: readonly AppKey[] | null | undefined,
): SetupImportUnavailableReason | null {
  if (!entity.importable) return "not_importable";
  // "Your trade has no menu" is a more fundamental fact than "you cannot
  // import it": a jewellery shop has no menu module, whatever it selects.
  if (entity.industryEligible === false) return "industry_module";
  if (!entity.granted) return "permission";
  const app = SETUP_IMPORT_MODULE_APP[entity.module];
  // `null`/`undefined` selection is the legacy unset state: keep the type
  // available exactly as an established business has always had it.
  if (app && selectedApps != null && !selectedApps.includes(app)) {
    return "app_not_selected";
  }
  return null;
}

export function setupImportReasonLabel(
  reason: SetupImportUnavailableReason | null,
  entity: Pick<SetupImportEntityInput, "module">,
): string | null {
  if (!reason) return null;
  if (reason === "not_importable") {
    return "ورود این نوع داده از فایل پشتیبانی نمی‌شود؛ آن را از صفحهٔ خودش ثبت کنید.";
  }
  if (reason === "industry_module") {
    return "این نوع داده با نوع کسب‌وکار شما سازگار نیست؛ در این صنف وجود ندارد.";
  }
  if (reason === "permission") {
    return "برای ورود این نوع داده، مجوز «ورود داده» و دسترسی همان بخش لازم است.";
  }
  const label = appLabel(SETUP_IMPORT_MODULE_APP[entity.module]);
  return label
    ? `برنامهٔ «${label}» انتخاب نشده است؛ برای ورود این داده ابتدا آن را در مرحلهٔ انتخاب برنامه‌ها انتخاب کنید.`
    : "برنامهٔ صاحب این داده انتخاب نشده است.";
}

/**
 * The candidate list, in registry order.
 *
 * Unavailable types are returned too — the brief requires them to be *visibly*
 * unavailable rather than silently missing or falsely offered.
 */
export function setupImportCandidates(
  entities: readonly SetupImportEntityInput[],
  selectedApps: readonly AppKey[] | null | undefined,
): SetupImportCandidate[] {
  return entities.map((entity) => {
    const reason = setupImportUnavailableReason(entity, selectedApps);
    const appKey = SETUP_IMPORT_MODULE_APP[entity.module];
    return {
      ...entity,
      moduleLabel: DATA_MODULE_LABELS[entity.module],
      appKey,
      appLabel: appLabel(appKey),
      available: reason === null,
      reason,
      reasonLabel: setupImportReasonLabel(reason, entity),
    };
  });
}

/**
 * A stored job's onboarding state.
 *
 * Deliberately *not* the engine's raw status: `pending` and `ready` are both
 * "waiting for the owner to finish the mapping/preview", and a `completed` job
 * with failed rows is not the same success as a clean one. Collapsing them here
 * is what lets every screen be truthful with one vocabulary.
 */
export type SetupImportSessionState =
  | "staged"
  | "applying"
  | "applied"
  | "partial"
  | "failed"
  | "cancelled";

export interface SetupImportJobInput {
  status: ImportJobStatus;
  failedRows: number;
}

export function setupImportSessionState(
  job: SetupImportJobInput,
): SetupImportSessionState {
  switch (job.status) {
    case "pending":
    case "ready":
      return "staged";
    case "queued":
    case "running":
      return "applying";
    case "completed":
      return job.failedRows > 0 ? "partial" : "applied";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

export const SETUP_IMPORT_STATE_LABELS: Record<
  SetupImportSessionState,
  string
> = {
  staged: "در انتظار تأیید",
  applying: "در حال اجرا",
  applied: "وارد شد",
  partial: "وارد شد — نیازمند بازبینی",
  failed: "ناموفق",
  cancelled: "لغو شد",
};

export type SetupImportStateTone =
  | "active"
  | "positive"
  | "neutral"
  | "danger";

export const SETUP_IMPORT_STATE_TONE: Record<
  SetupImportSessionState,
  SetupImportStateTone
> = {
  staged: "neutral",
  applying: "active",
  applied: "positive",
  partial: "active",
  failed: "danger",
  cancelled: "neutral",
};

/** States that still need the owner, and therefore belong on the dashboard. */
export function isUnfinishedSetupImport(
  state: SetupImportSessionState,
): boolean {
  return (
    state === "staged" ||
    state === "applying" ||
    state === "partial" ||
    state === "failed"
  );
}

export interface SetupImportSummary {
  total: number;
  applied: number;
  partial: number;
  staged: number;
  applying: number;
  failed: number;
  cancelled: number;
  /** Jobs that still need the owner or the worker. */
  unfinished: number;
}

export function setupImportSummary(
  states: readonly SetupImportSessionState[],
): SetupImportSummary {
  const summary: SetupImportSummary = {
    total: states.length,
    applied: 0,
    partial: 0,
    staged: 0,
    applying: 0,
    failed: 0,
    cancelled: 0,
    unfinished: 0,
  };
  for (const state of states) {
    summary[state] += 1;
    if (isUnfinishedSetupImport(state)) summary.unfinished += 1;
  }
  return summary;
}

/** One saved session, as the wizard, Finish and the dashboard read it. */
export interface SetupImportSession {
  id: string;
  entityKey: string;
  entityLabel: string;
  state: SetupImportSessionState;
  status: ImportJobStatus;
  fileName: string;
  createdAt: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  createdRows: number;
  updatedRows: number;
  skippedRows: number;
  failedRows: number;
  error: string | null;
}

export interface SetupImportsData {
  selectedApps: AppKey[] | null;
  canImport: boolean;
  candidates: SetupImportCandidate[];
  sessions: SetupImportSession[];
  summary: SetupImportSummary;
}
