/**
 * Interactive guided tours (issue #972) — the pure half.
 *
 * A tour is a short, ordered walk over the live UI of one page, started from
 * that page's existing «آموزش» button (`knowledge-help.tsx`) — never from a
 * second help button. This module holds everything that has no database or
 * DOM in it, so the API route, the runtime and the unit tests all read the
 * same definitions and the same progress rules:
 *
 *  - the catalogue (`TOURS`): code-defined, versioned and reviewed like any
 *    other source file. A Superadmin-authored catalogue is a later phase of
 *    the epic; nothing here prevents it, and `TourDefinition` is the shape
 *    that catalogue would store;
 *  - eligibility (`isTourEligible`): the same permission and industry facts
 *    the page's own guard reads, evaluated on the SERVER before a tour is
 *    ever described to a member (a tour's title is itself metadata);
 *  - progress (`applyTourEvent`, `tourProgressView`): what a member has
 *    *seen*, kept apart from the business setup wizard's `setup.progress`.
 *
 * Two rules carry the design:
 *
 *  - **Seen is not learned.** The only steps in this slice are explanations,
 *    so "seen" means the member pressed Next on them. A step that asks the
 *    member to do something real must complete on a server-verified success
 *    event, never on a click of Next — that step kind does not exist yet, and
 *    the progress API accepts no client-claimed success of any kind.
 *  - **Skipped is not seen.** A tour is completed only when every step has
 *    been seen; skipping leaves it in progress and the unseen steps still
 *    count against the denominator.
 *
 * Client-safe: imports types only, plus the industry list.
 */
import type { Industry } from "./industries";
import { PRODUCT_WORKSPACE_INDUSTRIES } from "./product-workspace";
import { PERMISSIONS, type Permission } from "./permissions";

/**
 * Every `data-tour-id` an owning component exposes. A tour step names an
 * anchor from this list, never a CSS class, a label or a DOM position, so a
 * restyle or a translation cannot silently detach a tour. `tours.test.ts`
 * fails when a registered anchor is not present in the source, or a source
 * anchor is not registered.
 */
export const TOUR_ANCHORS = {
  productsKpis: "products.kpis",
  productsToolbar: "products.toolbar",
  productsExport: "products.export",
  productsTable: "products.table",
} as const;

export type TourAnchor = (typeof TOUR_ANCHORS)[keyof typeof TOUR_ANCHORS];

/** The attribute a component puts on the element a tour may point at. */
export const TOUR_ANCHOR_ATTRIBUTE = "data-tour-id";

export type TourStepKind =
  /** Centered card — no element involved. */
  | "explain"
  /** Dimmed page with a cut-out around `anchor`. */
  | "spotlight";

export interface TourStep {
  /** Stable across revisions: progress is keyed on it. Never reuse an id for a different step. */
  id: string;
  kind: TourStepKind;
  /** Required for `spotlight`. */
  anchor?: TourAnchor;
  title: string;
  body: string;
}

export interface TourEligibility {
  /** All of these must be held. */
  permissions?: readonly Permission[];
  /** The business's industry must be one of these. Omitted = every trade. */
  industries?: readonly Industry[];
}

export interface TourDefinition {
  /** Stable id stored with progress. Lowercase, dotted. */
  id: string;
  /**
   * Bumped when the steps change in a way a member who finished the old tour
   * should look at again. Progress keeps every seen step whose id still
   * exists; a step added later is simply unseen, so a completed member is
   * asked to look at only what is new rather than being reset.
   */
  version: number;
  /** `KNOWLEDGE_PAGES` key (`page:/…`) whose «آموزش» button offers this tour. */
  pageKey: string;
  /** Canonical route the tour runs on. Leaving it pauses the tour. */
  route: string;
  title: string;
  description: string;
  eligibility: TourEligibility;
  steps: readonly TourStep[];
}

const PRODUCT_LIST_ROUTE = "/accounting/products";

export const TOURS: readonly TourDefinition[] = [
  {
    id: "accounting.products.list",
    version: 1,
    pageKey: `page:${PRODUCT_LIST_ROUTE}`,
    route: PRODUCT_LIST_ROUTE,
    title: "آشنایی با فهرست محصولات",
    description: "با نشانگرها، جست‌وجو و جدول موجودی و قیمت‌ها آشنا شوید.",
    eligibility: {
      permissions: [PERMISSIONS.inventoryView],
      industries: PRODUCT_WORKSPACE_INDUSTRIES,
    },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "فهرست محصولات",
        body:
          "این صفحه همهٔ کالاهای کسب‌وکار را با موجودی و قیمت نشان می‌دهد. در چند مرحله بخش‌های آن را می‌بینیم؛ این تور چیزی را تغییر نمی‌دهد.",
      },
      {
        id: "kpis",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.productsKpis,
        title: "نشانگرها",
        body: "کل محصولات، موجود، ناموجود و غیرقابل‌فروش را در یک نگاه ببینید.",
      },
      {
        id: "search-filters",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.productsToolbar,
        title: "جست‌وجو و فیلتر",
        body:
          "نام، کد کالا یا بارکد را جست‌وجو کنید، فهرست را بر اساس وضعیت فیلتر کنید و تعداد ردیف‌های هر صفحه را تغییر دهید.",
      },
      {
        id: "table",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.productsTable,
        title: "جدول کالاها",
        body:
          "هر ردیف یک کالا با موجودی، قیمت فروش و قیمت خرید است. از دکمه‌های انتهای ردیف برای ویرایش آن کالا استفاده کنید.",
      },
      {
        id: "export",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.productsExport,
        title: "دریافت فهرست",
        body: "فهرست فیلترشده را به‌صورت فایل CSV بگیرید تا در نرم‌افزارهای دیگر استفاده کنید.",
      },
    ],
  },
];

export function tourById(id: string): TourDefinition | undefined {
  return TOURS.find((tour) => tour.id === id);
}

/** Every tour registered for a page, eligible or not. Callers must filter with `isTourEligible`. */
export function toursForPage(pageKey: string): TourDefinition[] {
  return TOURS.filter((tour) => tour.pageKey === pageKey);
}

export interface TourViewer {
  permissions: ReadonlySet<string>;
  industry: Industry | string | null;
}

/**
 * Whether a member may be told this tour exists. The server calls it for the
 * lookup and again for every progress write, so a permission removed mid-tour
 * stops the writes, not just the button.
 */
export function isTourEligible(tour: TourDefinition, viewer: TourViewer): boolean {
  for (const permission of tour.eligibility.permissions ?? []) {
    if (!viewer.permissions.has(permission)) return false;
  }
  const industries = tour.eligibility.industries;
  if (industries && !(viewer.industry && (industries as readonly string[]).includes(viewer.industry))) {
    return false;
  }
  return true;
}

/** Structural problems with a catalogue, as sentences. Empty means publishable. */
export function validateTours(tours: readonly TourDefinition[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const anchors = new Set<string>(Object.values(TOUR_ANCHORS));
  for (const tour of tours) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tour.id)) problems.push(`${tour.id}: invalid id`);
    if (ids.has(tour.id)) problems.push(`${tour.id}: duplicate tour id`);
    ids.add(tour.id);
    if (!Number.isInteger(tour.version) || tour.version < 1) problems.push(`${tour.id}: invalid version`);
    if (tour.steps.length === 0) problems.push(`${tour.id}: no steps`);
    if (tour.steps.length > MAX_TOUR_STEPS) problems.push(`${tour.id}: more than ${MAX_TOUR_STEPS} steps`);
    if (!tour.pageKey.startsWith("page:") || tour.pageKey !== `page:${tour.route}`) {
      problems.push(`${tour.id}: pageKey must be page:<route>`);
    }
    const stepIds = new Set<string>();
    for (const step of tour.steps) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(step.id)) problems.push(`${tour.id}/${step.id}: invalid step id`);
      if (stepIds.has(step.id)) problems.push(`${tour.id}/${step.id}: duplicate step id`);
      stepIds.add(step.id);
      if (step.kind === "spotlight" && (!step.anchor || !anchors.has(step.anchor))) {
        problems.push(`${tour.id}/${step.id}: spotlight step needs a registered anchor`);
      }
      if (step.kind === "explain" && step.anchor) {
        problems.push(`${tour.id}/${step.id}: explain step must not name an anchor`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** Bounds the stored array: a definition may never outgrow what one row holds. */
export const MAX_TOUR_STEPS = 60;

/** What the `tour_member_progress` row holds, in camel case. Dates are ISO strings on the wire. */
export interface StoredTourProgress {
  tourId: string;
  tourVersion: number;
  seenStepIds: string[];
  /** The step to resume at; null once the tour is completed or before it starts. */
  currentStepId: string | null;
  startedAt: string;
  lastActiveAt: string;
  completedAt: string | null;
}

export type TourStatus = "not_started" | "in_progress" | "completed";

export interface TourProgressView {
  status: TourStatus;
  /** Steps of the CURRENT revision this member has seen. */
  seenCount: number;
  totalSteps: number;
  /** 0–100, floored, so "100" always means completed. */
  percent: number;
  /** A valid step id of the current revision to resume at, or null. */
  resumeStepId: string | null;
  /** The stored progress belongs to an older revision of the tour. */
  outdated: boolean;
  lastActiveAt: string | null;
  completedAt: string | null;
}

export type TourProgressEvent =
  | { type: "start" }
  | { type: "step_seen"; stepId: string }
  | { type: "pause"; stepId: string }
  | { type: "complete" }
  | { type: "reset" };

export const TOUR_EVENT_TYPES = ["start", "step_seen", "pause", "complete", "reset"] as const;

export type TourEventError = "unknown_step" | "steps_unseen";

/**
 * Narrows stored progress to what still applies to `tour`: seen ids that no
 * longer exist are dropped, and a completion is withdrawn when a step has
 * appeared that the member never saw. Pure and idempotent.
 */
export function reconcileTourProgress(
  tour: TourDefinition,
  stored: StoredTourProgress | null,
): StoredTourProgress | null {
  if (!stored) return null;
  const known = new Set(tour.steps.map((step) => step.id));
  const seenStepIds = stored.seenStepIds.filter((id) => known.has(id));
  const allSeen = tour.steps.every((step) => seenStepIds.includes(step.id));
  const currentStepId =
    stored.currentStepId && known.has(stored.currentStepId) ? stored.currentStepId : null;
  return {
    ...stored,
    seenStepIds,
    currentStepId,
    completedAt: stored.completedAt && allSeen ? stored.completedAt : null,
  };
}

function firstUnseenStep(tour: TourDefinition, seen: readonly string[]): string | null {
  return tour.steps.find((step) => !seen.includes(step.id))?.id ?? null;
}

/**
 * Applies one event and returns the next stored progress (or an error).
 *
 * Every transition is a monotone union of what was seen, so two devices
 * sending events in either order — or one device retrying — converge on the
 * same row. The one exception is `reset`, which is explicit and total.
 * Replaying a completed tour never lowers it: `start`, `step_seen` and
 * `pause` on a completed row only refresh `lastActiveAt`.
 */
export function applyTourEvent(
  tour: TourDefinition,
  previous: StoredTourProgress | null,
  event: TourProgressEvent,
  now: string,
): { ok: true; progress: StoredTourProgress | null } | { ok: false; error: TourEventError } {
  if (event.type === "reset") return { ok: true, progress: null };

  const base = reconcileTourProgress(tour, previous) ?? {
    tourId: tour.id,
    tourVersion: tour.version,
    seenStepIds: [],
    currentStepId: null,
    startedAt: now,
    lastActiveAt: now,
    completedAt: null,
  };
  const completed = base.completedAt !== null;
  const next: StoredTourProgress = {
    ...base,
    tourVersion: tour.version,
    lastActiveAt: now,
  };

  if (event.type === "start") {
    if (!completed) next.currentStepId = next.currentStepId ?? firstUnseenStep(tour, next.seenStepIds) ?? tour.steps[0]?.id ?? null;
    return { ok: true, progress: next };
  }

  if (event.type === "complete") {
    if (!tour.steps.every((step) => next.seenStepIds.includes(step.id))) {
      return { ok: false, error: "steps_unseen" };
    }
    next.completedAt = next.completedAt ?? now;
    next.currentStepId = null;
    return { ok: true, progress: next };
  }

  const index = tour.steps.findIndex((step) => step.id === event.stepId);
  if (index < 0) return { ok: false, error: "unknown_step" };

  if (event.type === "step_seen") {
    if (!next.seenStepIds.includes(event.stepId)) next.seenStepIds = [...next.seenStepIds, event.stepId];
    if (!completed) {
      next.currentStepId = firstUnseenStep(tour, next.seenStepIds) ?? tour.steps[index].id;
    }
    return { ok: true, progress: next };
  }

  // pause
  if (!completed) next.currentStepId = event.stepId;
  return { ok: true, progress: next };
}

/** The member-facing summary of a tour's progress, always against the CURRENT revision. */
export function tourProgressView(
  tour: TourDefinition,
  stored: StoredTourProgress | null,
): TourProgressView {
  const reconciled = reconcileTourProgress(tour, stored);
  const totalSteps = tour.steps.length;
  if (!reconciled) {
    return {
      status: "not_started",
      seenCount: 0,
      totalSteps,
      percent: 0,
      resumeStepId: null,
      outdated: false,
      lastActiveAt: null,
      completedAt: null,
    };
  }
  const seenCount = reconciled.seenStepIds.length;
  const completed = reconciled.completedAt !== null;
  const status: TourStatus = completed ? "completed" : seenCount > 0 || reconciled.currentStepId ? "in_progress" : "not_started";
  return {
    status,
    seenCount,
    totalSteps,
    percent: totalSteps === 0 ? 0 : completed ? 100 : Math.min(99, Math.floor((seenCount / totalSteps) * 100)),
    resumeStepId: completed ? null : reconciled.currentStepId ?? firstUnseenStep(tour, reconciled.seenStepIds),
    outdated: (stored?.tourVersion ?? tour.version) !== tour.version,
    lastActiveAt: reconciled.lastActiveAt,
    completedAt: reconciled.completedAt,
  };
}

/** What `GET /api/knowledge/tours` returns for one tour. Never carries step copy or anchors. */
export interface TourSummary {
  id: string;
  version: number;
  title: string;
  description: string;
  route: string;
  stepCount: number;
  progress: TourProgressView;
}

export function tourSummary(tour: TourDefinition, stored: StoredTourProgress | null): TourSummary {
  return {
    id: tour.id,
    version: tour.version,
    title: tour.title,
    description: tour.description,
    route: tour.route,
    stepCount: tour.steps.length,
    progress: tourProgressView(tour, stored),
  };
}

/** What the runtime needs once a member starts: the steps, nothing about eligibility. */
export interface TourPlayback {
  id: string;
  version: number;
  route: string;
  title: string;
  steps: readonly TourStep[];
}

export function tourPlayback(tour: TourDefinition): TourPlayback {
  return { id: tour.id, version: tour.version, route: tour.route, title: tour.title, steps: tour.steps };
}
