/**
 * Learning paths (issue #972, item 3) — the pure half.
 *
 * A learning path is a curated sequence of steps that guide a member through
 * a topic or goal: register the first customer, take the first order, do the
 * first reconciliation. Each step points at one thing the member does — a
 * guided tour, a knowledge-base article, or a page to visit — and the path's
 * progress is the union of what the member has completed.
 *
 * Three things stay apart on purpose:
 *
 *  - tour progress (`tour_member_progress`): what a member has seen of one
 *    tour; a path's tour step is complete when that tour is completed;
 *  - business setup readiness (`setup.progress`): whether the business is
 *    configured; completing a path says nothing about it;
 *  - learning path progress (this module): what a member has completed of one
 *    path, per business and per member.
 *
 * A step is complete when:
 *
 *  - `tour`: the tour's progress is `completed` (checked server-side against
 *    `tour_member_progress`);
 *  - `article`: the member marked it read (a client `step_completed` event);
 *  - `page`: the member marked it visited (a client `step_completed` event).
 *
 * The client never claims a tour step: the server confirms it through tour
 * progress, exactly as a verified action step is confirmed through evidence.
 *
 * Client-safe: pure data, no database and no DOM.
 */
import type { TourEligibility, TourViewer } from "./tours";

/** A step's target is a tour, an article, or a page. */
export type LearningPathStepKind = "tour" | "article" | "page";

export interface LearningPathStep {
  /** Stable across revisions: progress is keyed on it. Never reuse an id. */
  id: string;
  kind: LearningPathStepKind;
  /**
   * A tour id (`crm.directory.first-customer`), an article slug
   * (`getting-started`) or a canonical route (`/accounting/pos`). The server
   * resolves what it means; the client never interprets it.
   */
  target: string;
  title: string;
  body: string;
  /** Narrows the step for the viewer; omitted = every viewer the path offers. */
  eligibility?: TourEligibility;
}

export interface LearningPathDefinition {
  /** Stable id, lowercase dotted. */
  id: string;
  /** Bumped when steps change; a finished member is asked about what is new. */
  version: number;
  /** Navigation group this path is filed under. */
  group: string;
  title: string;
  body: string;
  eligibility: TourEligibility;
  steps: readonly LearningPathStep[];
}

/** The code catalogue — reviewed, versioned, shipped with a deployment. */
export const LEARNING_PATHS: readonly LearningPathDefinition[] = [
  {
    id: "cafe.first-day",
    version: 1,
    group: "فروش و عملیات",
    title: "اولین روز در کافه",
    body:
      "مشتری اول را ثبت کنید، یک محصول بسازید و اولین سفارش را بگیرید. هر مرحله یک کار واقعی است که خودتان انجام می‌دهید.",
    eligibility: {},
    steps: [
      {
        id: "register-customer",
        kind: "tour",
        target: "crm.directory.first-customer",
        title: "مشتری اول را ثبت کنید",
        body:
          "در فهرست مشتریان، «افزودن مشتری» را بزنید و فرم را ذخیره کنید. سرور ثبت را تأیید می‌کند.",
      },
      {
        id: "create-product",
        kind: "tour",
        target: "accounting.products.new",
        title: "اولین محصول را بسازید",
        body: "در صفحه محصولات، «افزودن محصول» را بزنید، نام را بنویسید و ثبت کنید.",
        eligibility: { permissions: ["inventory.adjust"] },
      },
      {
        id: "take-first-order",
        kind: "tour",
        target: "accounting.pos.order-ticket",
        title: "اولین سفارش را بگیرید",
        body: "در صندوق فروش، یک محصول را به سبد اضافه کنید و «دریافت وجه» را بزنید.",
        eligibility: { permissions: ["orders.create", "payments.take"] },
      },
    ],
  },
  {
    id: "retail.first-sale",
    version: 1,
    group: "فروش و عملیات",
    title: "اولین فروش خرده‌ای",
    body:
      "کالای خود را به فاکتور اضافه کنید، مشتری و روش پرداخت را مشخص کنید و فاکتور را ثبت کنید.",
    eligibility: {},
    steps: [
      {
        id: "add-item",
        kind: "tour",
        target: "accounting.pos.invoice",
        title: "کالای خود را به فاکتور اضافه کنید",
        body: "در صفحه صدور فاکتور، کالا را انتخاب کنید و به فاکتور اضافه کنید.",
      },
      {
        id: "set-payment",
        kind: "tour",
        target: "accounting.pos.invoice",
        title: "روش پرداخت را انتخاب کنید",
        body: "یکی از روش‌های دریافت وجه را انتخاب کنید.",
        eligibility: { permissions: ["payments.take"] },
      },
      {
        id: "submit-invoice",
        kind: "page",
        target: "/accounting/pos",
        title: "فاکتور را ثبت کنید",
        body: "دکمهٔ ثبت را ۲ ثانیه نگه دارید. تور این دکمه را نمی‌زند.",
      },
    ],
  },
];

export type LearningPathId = (typeof LEARNING_PATHS)[number]["id"];

function matchesEligibility(rule: TourEligibility, viewer: TourViewer): boolean {
  for (const permission of rule.permissions ?? []) {
    if (!viewer.permissions.has(permission)) return false;
  }
  for (const permission of rule.withoutPermissions ?? []) {
    if (viewer.permissions.has(permission)) return false;
  }
  return true;
}

/** Every path registered for a viewer, narrowed to their steps. */
export function pathsForViewer(
  paths: readonly LearningPathDefinition[],
  viewer: TourViewer,
): LearningPathDefinition[] {
  const result: LearningPathDefinition[] = [];
  for (const path of paths) {
    if (!matchesEligibility(path.eligibility, viewer)) continue;
    const steps = path.steps.filter(
      (step) => !step.eligibility || matchesEligibility(step.eligibility, viewer),
    );
    if (steps.length === 0) continue;
    result.push(steps.length === path.steps.length ? path : { ...path, steps });
  }
  return result;
}

/** Structural problems with a catalogue, as sentences. Empty means publishable. */
export function validateLearningPaths(
  paths: readonly LearningPathDefinition[],
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const path of paths) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(path.id)) {
      problems.push(`${path.id}: invalid path id`);
    }
    if (ids.has(path.id)) problems.push(`${path.id}: duplicate path id`);
    ids.add(path.id);
    if (!Number.isInteger(path.version) || path.version < 1) {
      problems.push(`${path.id}: invalid version`);
    }
    if (path.steps.length === 0) problems.push(`${path.id}: no steps`);
    const stepIds = new Set<string>();
    for (const step of path.steps) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(step.id)) {
        problems.push(`${path.id}/${step.id}: invalid step id`);
      }
      if (stepIds.has(step.id)) {
        problems.push(`${path.id}/${step.id}: duplicate step id`);
      }
      stepIds.add(step.id);
      if (!step.title.trim()) {
        problems.push(`${path.id}/${step.id}: title is required`);
      }
      if (!step.body.trim()) {
        problems.push(`${path.id}/${step.id}: body is required`);
      }
      if (!step.target.trim()) {
        problems.push(`${path.id}/${step.id}: target is required`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** What the `learning_path_progress` row holds, in camel case. */
export interface StoredLearningPathProgress {
  pathId: string;
  pathVersion: number;
  completedStepIds: string[];
  currentStepId: string | null;
  startedAt: string;
  lastActiveAt: string;
  completedAt: string | null;
}

export type LearningPathStatus = "not_started" | "in_progress" | "completed";

export interface LearningPathProgressView {
  status: LearningPathStatus;
  completedCount: number;
  totalSteps: number;
  /** 0–100, floored, so "100" always means completed. */
  percent: number;
  /** A valid step id of the current revision to resume at, or null. */
  resumeStepId: string | null;
  /** The stored progress belongs to an older revision of the path. */
  outdated: boolean;
  lastActiveAt: string | null;
  completedAt: string | null;
}

export type LearningPathEvent =
  | { type: "start" }
  | { type: "step_completed"; stepId: string }
  | { type: "pause"; stepId: string }
  | { type: "complete" }
  | { type: "reset" };

export const LEARNING_PATH_EVENT_TYPES = [
  "start",
  "step_completed",
  "pause",
  "complete",
  "reset",
] as const;

export type LearningPathEventError =
  | "unknown_step"
  | "steps_uncompleted"
  | "step_not_completable";

/**
 * Narrows stored progress to what still applies to `path`: completed ids that
 * no longer exist are dropped, and a completion is withdrawn when a step has
 * appeared that the member never completed. Pure and idempotent.
 */
export function reconcileLearningPathProgress(
  path: LearningPathDefinition,
  stored: StoredLearningPathProgress | null,
): StoredLearningPathProgress | null {
  if (!stored) return null;
  const known = new Set(path.steps.map((step) => step.id));
  const completedStepIds = stored.completedStepIds.filter((id) => known.has(id));
  const allCompleted = path.steps.every((step) => completedStepIds.includes(step.id));
  const currentStepId =
    stored.currentStepId && known.has(stored.currentStepId) ? stored.currentStepId : null;
  return {
    ...stored,
    completedStepIds,
    currentStepId,
    completedAt: stored.completedAt && allCompleted ? stored.completedAt : null,
  };
}

function firstIncompleteStep(
  path: LearningPathDefinition,
  completed: readonly string[],
): string | null {
  return path.steps.find((step) => !completed.includes(step.id))?.id ?? null;
}

/**
 * Applies one event and returns the next stored progress (or an error).
 *
 * Every transition is a monotone union of what was completed, so two devices
 * sending events in either order converge on the same row. Replaying a
 * completed path never lowers it.
 */
export function applyLearningPathEvent(
  path: LearningPathDefinition,
  previous: StoredLearningPathProgress | null,
  event: LearningPathEvent,
  now: string,
): { ok: true; progress: StoredLearningPathProgress | null } | { ok: false; error: LearningPathEventError } {
  if (event.type === "reset") return { ok: true, progress: null };

  const base = reconcileLearningPathProgress(path, previous) ?? {
    pathId: path.id,
    pathVersion: path.version,
    completedStepIds: [],
    currentStepId: null,
    startedAt: now,
    lastActiveAt: now,
    completedAt: null,
  };
  const completed = base.completedAt !== null;
  const next: StoredLearningPathProgress = {
    ...base,
    pathVersion: path.version,
    lastActiveAt: now,
  };

  if (event.type === "start") {
    if (!completed) {
      next.currentStepId =
        next.currentStepId ?? firstIncompleteStep(path, next.completedStepIds) ??
        path.steps[0]?.id ?? null;
    }
    return { ok: true, progress: next };
  }

  if (event.type === "complete") {
    if (!path.steps.every((step) => next.completedStepIds.includes(step.id))) {
      return { ok: false, error: "steps_uncompleted" };
    }
    next.completedAt = next.completedAt ?? now;
    next.currentStepId = null;
    return { ok: true, progress: next };
  }

  const index = path.steps.findIndex((step) => step.id === event.stepId);
  if (index < 0) return { ok: false, error: "unknown_step" };

  if (event.type === "step_completed") {
    if (!next.completedStepIds.includes(event.stepId)) {
      next.completedStepIds = [...next.completedStepIds, event.stepId];
    }
    if (!completed) {
      next.currentStepId = firstIncompleteStep(path, next.completedStepIds) ?? event.stepId;
    }
    return { ok: true, progress: next };
  }

  // pause
  if (!completed) next.currentStepId = event.stepId;
  return { ok: true, progress: next };
}

/**
 * The member-facing summary of a path's progress, always against the CURRENT
 * revision. `completedSteps` are step ids the server knows are done from
 * outside this row — today, completed tours referenced by `tour` steps.
 */
export function learningPathProgressView(
  path: LearningPathDefinition,
  stored: StoredLearningPathProgress | null,
  completedSteps: Set<string> = new Set(),
): LearningPathProgressView {
  const reconciled = reconcileLearningPathProgress(path, stored);
  const totalSteps = path.steps.length;
  if (!reconciled) {
    return {
      status: "not_started",
      completedCount: 0,
      totalSteps,
      percent: 0,
      resumeStepId: firstIncompleteStep(path, []),
      outdated: false,
      lastActiveAt: null,
      completedAt: null,
    };
  }
  const merged = new Set([...reconciled.completedStepIds, ...completedSteps]);
  const completedCount = merged.size;
  const pathCompleted = reconciled.completedAt !== null;
  const status: LearningPathStatus = pathCompleted
    ? "completed"
    : completedCount > 0 || reconciled.currentStepId
      ? "in_progress"
      : "not_started";
  return {
    status,
    completedCount,
    totalSteps,
    percent:
      totalSteps === 0 ? 0 : pathCompleted ? 100 : Math.min(99, Math.floor((completedCount / totalSteps) * 100)),
    resumeStepId: pathCompleted
      ? null
      : reconciled.currentStepId ?? firstIncompleteStep(path, reconciled.completedStepIds),
    outdated: (stored?.pathVersion ?? path.version) !== path.version,
    lastActiveAt: reconciled.lastActiveAt,
    completedAt: reconciled.completedAt,
  };
}

/** What `GET /api/knowledge/learning-paths` returns for one path. */
export interface LearningPathSummary {
  id: string;
  version: number;
  group: string;
  title: string;
  body: string;
  stepCount: number;
  progress: LearningPathProgressView;
}

export function learningPathSummary(
  path: LearningPathDefinition,
  stored: StoredLearningPathProgress | null,
  completedSteps: Set<string> = new Set(),
): LearningPathSummary {
  return {
    id: path.id,
    version: path.version,
    group: path.group,
    title: path.title,
    body: path.body,
    stepCount: path.steps.length,
    progress: learningPathProgressView(path, stored, completedSteps),
  };
}

export function learningPathById(id: string): LearningPathDefinition | undefined {
  return LEARNING_PATHS.find((path) => path.id === id);
}
