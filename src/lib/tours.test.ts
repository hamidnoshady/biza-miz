import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWLEDGE_PAGES } from "./knowledge-base";
import { PERMISSIONS } from "./permissions";
import {
  TOURS,
  TOUR_ANCHORS,
  applyTourEvent,
  isTourEligible,
  reconcileTourProgress,
  tourById,
  tourPlayback,
  tourProgressView,
  tourSummary,
  toursForPage,
  validateTours,
  type StoredTourProgress,
  type TourDefinition,
  type TourProgressEvent,
} from "./tours";

const T0 = "2026-10-26T10:00:00.000Z";
const T1 = "2026-10-26T10:05:00.000Z";

const tour: TourDefinition = {
  id: "test.tour",
  version: 1,
  pageKey: "page:/accounting/products",
  route: "/accounting/products",
  title: "تور آزمایشی",
  description: "توضیح",
  eligibility: {},
  steps: [
    { id: "a", kind: "explain", title: "الف", body: "." },
    { id: "b", kind: "spotlight", anchor: TOUR_ANCHORS.productsToolbar, title: "ب", body: "." },
    { id: "c", kind: "spotlight", anchor: TOUR_ANCHORS.productsTable, title: "ج", body: "." },
  ],
};

function run(events: TourProgressEvent[], from: StoredTourProgress | null = null, def = tour) {
  let progress = from;
  for (const event of events) {
    const result = applyTourEvent(def, progress, event, T1);
    if (!result.ok) throw new Error(result.error);
    progress = result.progress;
  }
  return progress;
}

describe("the tour catalogue", () => {
  it("is structurally valid", () => {
    expect(validateTours(TOURS)).toEqual([]);
  });

  it("only attaches to pages that carry a knowledge button", () => {
    const pages = new Set(KNOWLEDGE_PAGES.map((page) => page.key));
    for (const def of TOURS) expect(pages.has(def.pageKey), def.id).toBe(true);
  });

  it("names every registered anchor in the owning source, and registers every source anchor", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) sources.push(readFileSync(full, "utf8"));
      }
    };
    walk(join(process.cwd(), "src"));
    const found = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/data-tour-id="([^"]+)"/g)) found.add(match[1]);
    }
    expect([...found].sort()).toEqual(Object.values(TOUR_ANCHORS).sort());
  });

  it("rejects a malformed catalogue", () => {
    const bad: TourDefinition = {
      ...tour,
      steps: [
        { id: "a", kind: "spotlight", title: "x", body: "." },
        { id: "a", kind: "explain", anchor: TOUR_ANCHORS.productsTable, title: "x", body: "." },
      ],
    };
    const problems = validateTours([bad, bad]);
    expect(problems.some((p) => p.includes("duplicate tour id"))).toBe(true);
    expect(problems.some((p) => p.includes("duplicate step id"))).toBe(true);
    expect(problems.some((p) => p.includes("needs a registered anchor"))).toBe(true);
    expect(problems.some((p) => p.includes("must not name an anchor"))).toBe(true);
  });

  it("looks tours up by id and page", () => {
    expect(tourById("accounting.products.list")?.route).toBe("/accounting/products");
    expect(tourById("nope")).toBeUndefined();
    expect(toursForPage("page:/accounting/products").map((t) => t.id)).toContain("accounting.products.list");
    expect(toursForPage("page:/crm/audit")).toEqual([]);
  });
});

describe("tour eligibility", () => {
  const products = tourById("accounting.products.list")!;

  it("needs the page's permission and a trade that has the products workspace", () => {
    const allowed = new Set<string>([PERMISSIONS.inventoryView]);
    expect(isTourEligible(products, { permissions: allowed, industry: "cosmetics" })).toBe(true);
    expect(isTourEligible(products, { permissions: new Set(), industry: "cosmetics" })).toBe(false);
    expect(isTourEligible(products, { permissions: allowed, industry: "food_service" })).toBe(false);
    expect(isTourEligible(products, { permissions: allowed, industry: null })).toBe(false);
  });

  it("is open to everyone when it declares nothing", () => {
    expect(isTourEligible(tour, { permissions: new Set(), industry: null })).toBe(true);
  });

  it("never describes steps or anchors in a summary", () => {
    const summary = tourSummary(products, null);
    expect(JSON.stringify(summary)).not.toContain("data-tour-id");
    expect(JSON.stringify(summary)).not.toContain(products.steps[1].body);
    expect(summary.stepCount).toBe(products.steps.length);
    expect(tourPlayback(products).steps).toHaveLength(products.steps.length);
  });
});

describe("tour progress", () => {
  it("starts at the first step and counts nothing as seen", () => {
    const progress = run([{ type: "start" }])!;
    expect(progress.currentStepId).toBe("a");
    expect(progress.seenStepIds).toEqual([]);
    expect(tourProgressView(tour, progress)).toMatchObject({ status: "in_progress", seenCount: 0, resumeStepId: "a" });
  });

  it("moves the resume point to the first unseen step", () => {
    const progress = run([{ type: "start" }, { type: "step_seen", stepId: "a" }, { type: "step_seen", stepId: "b" }])!;
    const view = tourProgressView(tour, progress);
    expect(view).toMatchObject({ status: "in_progress", seenCount: 2, totalSteps: 3, percent: 66, resumeStepId: "c" });
  });

  it("treats a pause as the resume point", () => {
    const progress = run([{ type: "start" }, { type: "step_seen", stepId: "a" }, { type: "pause", stepId: "c" }])!;
    expect(tourProgressView(tour, progress).resumeStepId).toBe("c");
  });

  it("refuses to complete while a step is unseen (skipped is not seen)", () => {
    const partial = run([{ type: "start" }, { type: "step_seen", stepId: "a" }, { type: "step_seen", stepId: "c" }])!;
    expect(applyTourEvent(tour, partial, { type: "complete" }, T1)).toEqual({ ok: false, error: "steps_unseen" });
  });

  it("completes only when every step was seen, and never reports 99% as done", () => {
    const almost = run([{ type: "step_seen", stepId: "a" }, { type: "step_seen", stepId: "b" }])!;
    expect(tourProgressView(tour, almost).percent).toBeLessThan(100);
    const done = run([{ type: "step_seen", stepId: "c" }, { type: "complete" }], almost)!;
    expect(tourProgressView(tour, done)).toMatchObject({ status: "completed", percent: 100, resumeStepId: null });
    expect(done.completedAt).toBe(T1);
  });

  it("rejects a step id the tour does not have", () => {
    expect(applyTourEvent(tour, null, { type: "step_seen", stepId: "zzz" }, T1)).toEqual({ ok: false, error: "unknown_step" });
    expect(applyTourEvent(tour, null, { type: "pause", stepId: "zzz" }, T1)).toEqual({ ok: false, error: "unknown_step" });
  });

  it("does not lower a completed tour when it is replayed", () => {
    const done = run(["a", "b", "c"].map((stepId) => ({ type: "step_seen" as const, stepId })).concat([{ type: "complete" } as never]))!;
    const replay = run([{ type: "start" }, { type: "pause", stepId: "b" }, { type: "step_seen", stepId: "a" }], done)!;
    expect(replay.completedAt).toBe(done.completedAt);
    expect(replay.seenStepIds).toEqual(done.seenStepIds);
    expect(replay.currentStepId).toBeNull();
    expect(tourProgressView(tour, replay).status).toBe("completed");
  });

  it("converges whatever order two devices report in, and when an event is retried", () => {
    const events: TourProgressEvent[] = [
      { type: "step_seen", stepId: "a" },
      { type: "step_seen", stepId: "b" },
      { type: "step_seen", stepId: "c" },
    ];
    const forward = run(events)!;
    const backward = run([...events].reverse())!;
    const retried = run([...events, ...events])!;
    expect([...forward.seenStepIds].sort()).toEqual([...backward.seenStepIds].sort());
    expect([...forward.seenStepIds].sort()).toEqual([...retried.seenStepIds].sort());
    expect(retried.seenStepIds).toHaveLength(3);
  });

  it("resets only on an explicit reset", () => {
    const some = run([{ type: "step_seen", stepId: "a" }])!;
    expect(applyTourEvent(tour, some, { type: "reset" }, T1)).toEqual({ ok: true, progress: null });
    expect(tourProgressView(tour, null).status).toBe("not_started");
  });

  describe("when the tour is revised", () => {
    const completed = run([
      { type: "step_seen", stepId: "a" },
      { type: "step_seen", stepId: "b" },
      { type: "step_seen", stepId: "c" },
      { type: "complete" },
    ])!;

    it("keeps compatible steps and asks only about what is new", () => {
      const v2: TourDefinition = {
        ...tour,
        version: 2,
        steps: [...tour.steps, { id: "d", kind: "explain", title: "د", body: "." }],
      };
      const view = tourProgressView(v2, completed);
      expect(view).toMatchObject({ status: "in_progress", seenCount: 3, totalSteps: 4, outdated: true, resumeStepId: "d" });
      expect(reconcileTourProgress(v2, completed)?.completedAt).toBeNull();
    });

    it("forgets steps that no longer exist without lowering the rest", () => {
      const v2: TourDefinition = { ...tour, version: 2, steps: tour.steps.filter((s) => s.id !== "b") };
      const view = tourProgressView(v2, completed);
      expect(view).toMatchObject({ status: "completed", seenCount: 2, totalSteps: 2, outdated: true });
    });

    it("records the new version on the next write", () => {
      const v2: TourDefinition = { ...tour, version: 2 };
      expect(run([{ type: "start" }], completed, v2)?.tourVersion).toBe(2);
    });
  });
});
