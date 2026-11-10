/**
 * Learning paths (issue #972, item 3) — the pure half.
 */
import { describe, expect, it } from "vitest";
import { PERMISSIONS, type Permission } from "./permissions";
import { type TourViewer } from "./tours";
import {
  applyLearningPathEvent,
  learningPathById,
  learningPathProgressView,
  learningPathSummary,
  LEARNING_PATHS,
  pathsForViewer,
  reconcileLearningPathProgress,
  validateLearningPaths,
  type LearningPathDefinition,
  type LearningPathEvent,
  type StoredLearningPathProgress,
} from "./learning-paths";

const T0 = "2026-11-06T10:00:00.000Z";
const T1 = "2026-11-06T10:05:00.000Z";

const path: LearningPathDefinition = {
  id: "cafe.first-day",
  version: 1,
  group: "فروش و عملیات",
  title: "اولین روز در کافه",
  body: "مشتری اول را ثبت کنید، یک محصول بسازید و اولین سفارش را بگیرید.",
  eligibility: {},
  steps: [
    { id: "register-customer", kind: "tour", target: "crm.directory.first-customer", title: "مشتری", body: "." },
    { id: "create-product", kind: "tour", target: "accounting.products.new", title: "محصول", body: ".", eligibility: { permissions: ["inventory.adjust"] } },
    { id: "take-first-order", kind: "tour", target: "accounting.pos.order-ticket", title: "سفارش", body: ".", eligibility: { permissions: ["orders.create", "payments.take"] } },
  ],
};

function run(
  events: LearningPathEvent[],
  from: StoredLearningPathProgress | null = null,
  def: LearningPathDefinition = path,
) {
  let progress = from;
  for (const event of events) {
    const result = applyLearningPathEvent(def, progress, event, T1);
    if (!result.ok) throw new Error(result.error);
    progress = result.progress as StoredLearningPathProgress | null;
  }
  return progress;
}

const viewer: TourViewer = {
  permissions: new Set([PERMISSIONS.inventoryAdjust, PERMISSIONS.ordersCreate, PERMISSIONS.paymentsTake]),
  industry: "cosmetics",
};

describe("the path catalogue", () => {
  it("is structurally valid", () => {
    expect(validateLearningPaths(LEARNING_PATHS)).toEqual([]);
  });

  it("resolves by id", () => {
    expect(learningPathById("cafe.first-day")?.id).toBe("cafe.first-day");
    expect(learningPathById("does.not.exist")).toBeUndefined();
  });
});

describe("eligibility", () => {
  it("narrows steps per viewer", () => {
    const visible = pathsForViewer([path], viewer);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.steps.map((s) => s.id)).toEqual([
      "register-customer",
      "create-product",
      "take-first-order",
    ]);
  });

  it("hides steps the viewer cannot reach", () => {
    const readOnly: TourViewer = { permissions: new Set(), industry: "cosmetics" };
    const visible = pathsForViewer([path], readOnly);
    expect(visible[0]!.steps.map((s) => s.id)).toEqual(["register-customer"]);
  });

  it("hides a path entirely when the viewer is not eligible", () => {
    const admin: TourViewer = { permissions: new Set(["something.else"]), industry: "cosmetics" };
    // cafe.first-day has no path-level eligibility, so it's always visible;
    // test with a path that has eligibility instead
    const gated: LearningPathDefinition = { ...path, eligibility: { permissions: ["ledger.view"] as Permission[] } };
    const visible = pathsForViewer([gated], viewer);
    expect(visible).toHaveLength(0);
  });
});

describe("progress events", () => {
  it("starts a path", () => {
    const progress = run([{ type: "start" }]);
    expect(progress!.startedAt).toBe(T1);
    expect(progress!.currentStepId).toBe("register-customer");
    expect(progress!.completedStepIds).toEqual([]);
    expect(progress!.completedAt).toBeNull();
  });

  it("completes steps in any order", () => {
    const progress = run([
      { type: "start" },
      { type: "step_completed", stepId: "take-first-order" },
      { type: "step_completed", stepId: "register-customer" },
    ]);
    expect(progress!.completedStepIds.sort()).toEqual(["register-customer", "take-first-order"]);
    expect(progress!.currentStepId).toBe("create-product");
  });

  it("completes the path when all steps are done", () => {
    const progress = run([
      { type: "start" },
      { type: "step_completed", stepId: "register-customer" },
      { type: "step_completed", stepId: "create-product" },
      { type: "step_completed", stepId: "take-first-order" },
      { type: "complete" },
    ]);
    expect(progress!.completedAt).toBe(T1);
    expect(progress!.currentStepId).toBeNull();
  });

  it("refuses complete when steps remain", () => {
    const result = applyLearningPathEvent(path, null, { type: "complete" }, T1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("steps_uncompleted");
  });

  it("refuses unknown step", () => {
    const result = applyLearningPathEvent(
      path,
      null,
      { type: "step_completed", stepId: "no-such-step" },
      T1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("unknown_step");
  });

  it("resets to nothing", () => {
    const progressed = run([{ type: "start" }, { type: "step_completed", stepId: "register-customer" }]);
    const reset = applyLearningPathEvent(path, progressed, { type: "reset" }, T1);
    expect(reset.ok).toBe(true);
    if (reset.ok) expect(reset.progress).toBeNull();
  });

  it("is idempotent: completing the same step twice is a no-op", () => {
    const first = run([{ type: "step_completed", stepId: "register-customer" }]);
    const second = applyLearningPathEvent(path, first, { type: "step_completed", stepId: "register-customer" }, T1);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.progress!.completedStepIds).toEqual(["register-customer"]);
  });
});

describe("reconciliation", () => {
  it("drops completed ids for steps that no longer exist", () => {
    const stored: StoredLearningPathProgress = {
      pathId: "cafe.first-day",
      pathVersion: 1,
      completedStepIds: ["register-customer", "gone.step"],
      currentStepId: "gone.step",
      startedAt: T0,
      lastActiveAt: T1,
      completedAt: null,
    };
    const reconciled = reconcileLearningPathProgress(path, stored);
    expect(reconciled!.completedStepIds).toEqual(["register-customer"]);
    expect(reconciled!.currentStepId).toBeNull();
  });

  it("withdraws completion when a new step appears", () => {
    const stored: StoredLearningPathProgress = {
      pathId: "cafe.first-day",
      pathVersion: 1,
      completedStepIds: ["register-customer", "create-product", "take-first-order"],
      currentStepId: null,
      startedAt: T0,
      lastActiveAt: T1,
      completedAt: T0,
    };
    const extended: LearningPathDefinition = {
      ...path,
      steps: [...path.steps, { id: "new-step", kind: "page", target: "/x", title: "ن", body: "." }],
    };
    const reconciled = reconcileLearningPathProgress(extended, stored);
    expect(reconciled!.completedAt).toBeNull();
  });
});

describe("progress view", () => {
  it("reports not_started with no stored progress", () => {
    const view = learningPathProgressView(path, null);
    expect(view.status).toBe("not_started");
    expect(view.percent).toBe(0);
    expect(view.resumeStepId).toBe("register-customer");
  });

  it("reports in_progress with some steps done", () => {
    const progress = run([{ type: "start" }, { type: "step_completed", stepId: "register-customer" }]);
    const view = learningPathProgressView(path, progress);
    expect(view.status).toBe("in_progress");
    expect(view.completedCount).toBe(1);
    expect(view.totalSteps).toBe(3);
    expect(view.percent).toBe(33);
    expect(view.resumeStepId).toBe("create-product");
  });

  it("caps percent at 99 until complete", () => {
    const progress = run([
      { type: "start" },
      { type: "step_completed", stepId: "register-customer" },
      { type: "step_completed", stepId: "create-product" },
    ]);
    const view = learningPathProgressView(path, progress);
    expect(view.percent).toBe(66);
    expect(view.status).toBe("in_progress");
  });

  it("reports 100 when completed", () => {
    const progress = run([
      { type: "start" },
      { type: "step_completed", stepId: "register-customer" },
      { type: "step_completed", stepId: "create-product" },
      { type: "step_completed", stepId: "take-first-order" },
      { type: "complete" },
    ]);
    const view = learningPathProgressView(path, progress);
    expect(view.status).toBe("completed");
    expect(view.percent).toBe(100);
    expect(view.resumeStepId).toBeNull();
  });

  it("marks outdated when the version changed", () => {
    const stored: StoredLearningPathProgress = {
      pathId: "cafe.first-day",
      pathVersion: 1,
      completedStepIds: [],
      currentStepId: null,
      startedAt: T0,
      lastActiveAt: T1,
      completedAt: null,
    };
    const v2 = { ...path, version: 2 };
    const view = learningPathProgressView(v2, stored);
    expect(view.outdated).toBe(true);
  });
});
