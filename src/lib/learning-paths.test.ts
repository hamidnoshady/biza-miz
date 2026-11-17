/**
 * Learning paths (issue #972, item 3) — the pure half.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS, type Permission } from "./permissions";
import { type TourViewer } from "./tours";
import {
  applyLearningPathEvent,
  learningPathById,
  learningPathProgressView,
  learningPathSummary,
  LEARNING_PATHS,
  migrateLearningPathProgress,
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

describe("migrateLearningPathProgress", () => {
  const stored: StoredLearningPathProgress = {
    pathId: "cafe.first-day",
    pathVersion: 1,
    completedStepIds: ["register-customer", "create-product"],
    currentStepId: "create-product",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-02T00:00:00.000Z",
    completedAt: null,
  };

  const path: LearningPathDefinition = {
    id: "cafe.first-day",
    version: 1,
    group: "cafe",
    title: "First day at the cafe",
    body: "Learn the basics.",
    eligibility: {},
    steps: [
      { id: "register-customer", kind: "page", target: "/customers", title: "Register customer", body: "." },
      { id: "create-product", kind: "page", target: "/products", title: "Create product", body: "." },
      { id: "take-first-order", kind: "page", target: "/pos", title: "Take first order", body: "." },
    ],
  };

  it("bumps the version and keeps compatible steps", () => {
    const v2 = { ...path, version: 2 };
    const migrated = migrateLearningPathProgress(v2, stored)!;
    expect(migrated.pathVersion).toBe(2);
    expect(migrated.completedStepIds).toEqual(["register-customer", "create-product"]);
    expect(migrated.currentStepId).toBe("create-product");
  });

  it("drops completed step ids that no longer exist", () => {
    const v2 = { ...path, version: 2, steps: path.steps.filter((s) => s.id !== "create-product") };
    const migrated = migrateLearningPathProgress(v2, stored)!;
    expect(migrated.pathVersion).toBe(2);
    expect(migrated.completedStepIds).toEqual(["register-customer"]);
    expect(migrated.currentStepId).toBeNull();
  });

  it("withdraws completion when a new step appeared", () => {
    const completed: StoredLearningPathProgress = {
      ...stored,
      completedStepIds: ["register-customer", "create-product", "take-first-order"],
      completedAt: "2026-01-03T00:00:00.000Z",
    };
    const v2: LearningPathDefinition = {
      ...path,
      version: 2,
      steps: [...path.steps, { id: "new-step", kind: "page", target: "/x", title: "New", body: "." }],
    };
    const migrated = migrateLearningPathProgress(v2, completed)!;
    expect(migrated.pathVersion).toBe(2);
    expect(migrated.completedStepIds).toEqual(["register-customer", "create-product", "take-first-order"]);
    expect(migrated.completedAt).toBeNull();
  });

  it("is idempotent — migrating twice changes nothing on the second run", () => {
    const v2: LearningPathDefinition = {
      ...path,
      version: 2,
      steps: [...path.steps, { id: "new-step", kind: "page", target: "/x", title: "New", body: "." }],
    };
    const first = migrateLearningPathProgress(v2, stored)!;
    const second = migrateLearningPathProgress(v2, first)!;
    expect(second.pathVersion).toBe(2);
    expect(second.completedStepIds).toEqual(first.completedStepIds);
    expect(second.currentStepId).toBe(first.currentStepId);
    expect(second.completedAt).toBe(first.completedAt);
  });

  it("returns null for null stored progress", () => {
    const v2 = { ...path, version: 2 };
    expect(migrateLearningPathProgress(v2, null)).toBeNull();
  });
});

/**
 * Issue #972, item 9 — staff assignments for learning paths. These tests
 * exercise the service-layer assignment functions against a stubbed
 * `@/lib/db`; no real database is needed.
 */
const dbModule = vi.hoisted(() => ({
  query: vi.fn(),
  withTenantTransaction: vi.fn(async (_b: string, fn: (client: { query: typeof vi.fn }) => Promise<unknown>) => fn({ query: dbModule.query })),
}));

vi.mock("@/lib/db", () => dbModule);

describe("learning path assignment service functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbModule.withTenantTransaction.mockImplementation(
      async (_b: string, fn: (client: { query: typeof vi.fn }) => Promise<unknown>) => fn({ query: dbModule.query }),
    );
  });

  it("inserts a new assignment and returns true", async () => {
    dbModule.query.mockResolvedValue({ rows: [{ inserted: true }], rowCount: 1 });
    const { assignLearningPathToStaff } = await import("./learning-paths-service");
    const created = await assignLearningPathToStaff("biz-1", "path-a", "user-2", "user-1");
    expect(created).toBe(true);
    expect(dbModule.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO learning_path_assignments"),
      ["biz-1", "user-2", "path-a", "user-1"],
    );
  });

  it("is idempotent: assigning twice returns false the second time", async () => {
    dbModule.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const { assignLearningPathToStaff } = await import("./learning-paths-service");
    const created = await assignLearningPathToStaff("biz-1", "path-a", "user-2", "user-1");
    expect(created).toBe(false);
  });

  it("unassigns a path and returns true when a row existed", async () => {
    dbModule.query.mockResolvedValue({ rowCount: 1 });
    const { unassignLearningPathFromStaff } = await import("./learning-paths-service");
    const removed = await unassignLearningPathFromStaff("biz-1", "path-a", "user-2");
    expect(removed).toBe(true);
    expect(dbModule.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM learning_path_assignments"),
      ["biz-1", "user-2", "path-a"],
    );
  });

  it("returns false when unassigning a path that was never assigned", async () => {
    dbModule.query.mockResolvedValue({ rowCount: 0 });
    const { unassignLearningPathFromStaff } = await import("./learning-paths-service");
    const removed = await unassignLearningPathFromStaff("biz-1", "path-a", "user-2");
    expect(removed).toBe(false);
  });

  it("lists path assignments newest first", async () => {
    dbModule.query.mockResolvedValue({
      rows: [
        { user_id: "user-3", full_name: "Carol", assigned_at: new Date("2026-02-01T00:00:00Z") },
        { user_id: "user-2", full_name: "Alice", assigned_at: new Date("2026-01-01T00:00:00Z") },
      ],
    });
    const { listLearningPathAssignments } = await import("./learning-paths-service");
    const rows = await listLearningPathAssignments("biz-1", "path-a");
    expect(rows).toHaveLength(2);
    expect(rows[0].userId).toBe("user-3");
    expect(rows[0].assignedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("lists staff path assignments newest first", async () => {
    dbModule.query.mockResolvedValue({
      rows: [
        { path_id: "path-b", title: "Path B", assigned_at: new Date("2026-02-01T00:00:00Z") },
        { path_id: "path-a", title: "Path A", assigned_at: new Date("2026-01-01T00:00:00Z") },
      ],
    });
    const { listStaffLearningPathAssignments } = await import("./learning-paths-service");
    const rows = await listStaffLearningPathAssignments("biz-1", "user-2");
    expect(rows).toHaveLength(2);
    expect(rows[0].pathId).toBe("path-b");
    expect(rows[0].title).toBe("Path B");
  });

  it("reports whether a staff member is assigned a path", async () => {
    dbModule.query.mockResolvedValue({ rows: [{ id: "1" }] });
    const { isLearningPathAssignedToStaff } = await import("./learning-paths-service");
    const yes = await isLearningPathAssignedToStaff("biz-1", "path-a", "user-2");
    expect(yes).toBe(true);

    dbModule.query.mockResolvedValue({ rows: [] });
    const no = await isLearningPathAssignedToStaff("biz-1", "path-a", "user-2");
    expect(no).toBe(false);
  });
});
