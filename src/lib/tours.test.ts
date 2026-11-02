import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INDUSTRIES, type Industry } from "./industries";
import { hasCapability, hasModule } from "./industry-profile";
import { KNOWLEDGE_PAGES } from "./knowledge-base";
import { ALL_PERMISSIONS, PERMISSIONS } from "./permissions";
import { PRODUCT_WORKSPACE_INDUSTRIES } from "./product-workspace";
import { SERVICE_INVOICE_INDUSTRIES } from "./service-invoice";
import {
  TOURS,
  TOUR_ANCHORS,
  applyTourEvent,
  isTourEligible,
  reconcileTourProgress,
  tourById,
  tourFactsNeeded,
  tourForViewer,
  tourPlayback,
  tourProgressView,
  tourSummary,
  toursForPage,
  toursForViewer,
  validateTours,
  type StoredTourProgress,
  type TourDefinition,
  type TourInventorySystem,
  type TourProgressEvent,
  type TourViewer,
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


// ---------------------------------------------------------------------------
// Coverage of the pages that have a published Knowledge Base article (#972)
// ---------------------------------------------------------------------------

const ARTICLE_PAGES = [
  "page:/accounting/overview",
  "page:/accounting/pos",
  "page:/accounting/inventory",
  "page:/accounting/cosmetics",
  "page:/accounting/products",
  "page:/accounting/products/new",
  "page:/accounting/products/prices",
  "page:/accounting/products/attributes",
  "page:/accounting/products/reports",
  "page:/accounting/products/barcode-templates",
] as const;

const everyPermission = new Set<string>(ALL_PERMISSIONS);
const noPermission = new Set<string>();
const withoutLedger = new Set<string>(ALL_PERMISSIONS.filter((p) => p !== PERMISSIONS.ledgerView));

function viewer(
  industry: Industry | null,
  permissions: ReadonlySet<string> = everyPermission,
  extra: Partial<TourViewer> = {},
): TourViewer {
  return {
    permissions,
    industry,
    features: { ledger: true, inventory: true },
    inventorySystem: "perpetual",
    ...extra,
  };
}

const idsFor = (page: string, v: TourViewer) => toursForViewer(page, v).map((t) => t.id);

describe("tour coverage of the ten article pages", () => {
  it("has at least one tour for each of them, and every tour page is a real «آموزش» page", () => {
    for (const page of ARTICLE_PAGES) expect(toursForPage(page).length, page).toBeGreaterThan(0);
    const known = new Set(KNOWLEDGE_PAGES.map((p) => p.key));
    for (const def of TOURS) expect(known.has(def.pageKey), def.id).toBe(true);
  });

  it("keeps the original five-step products tour as it was", () => {
    const original = tourById("accounting.products.list")!;
    expect(original.version).toBe(1);
    expect(original.steps.map((step) => step.id)).toEqual(["welcome", "kpis", "search-filters", "table", "export"]);
  });

  it("offers a member at most one tour per page, and always the one for the screen they get", () => {
    for (const industry of INDUSTRIES) {
      for (const inventorySystem of ["perpetual", "periodic"] as TourInventorySystem[]) {
        for (const permissions of [everyPermission, withoutLedger, noPermission]) {
          for (const features of [{ ledger: true, inventory: true }, { ledger: false, inventory: false }]) {
            const v = viewer(industry, permissions, { features, inventorySystem });
            for (const page of ARTICLE_PAGES) {
              expect(idsFor(page, v).length, `${industry} ${page}`).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
  });

  it("only offers Cosmetics to the right industry and the page's view permission", () => {
    const page = "page:/accounting/cosmetics";
    for (const industry of INDUSTRIES) {
      expect(idsFor(page, viewer(industry)), industry).toEqual(
        industry === "cosmetics" ? ["accounting.cosmetics.specialized"] : [],
      );
    }
    expect(idsFor(page, viewer("cosmetics", noPermission))).toEqual([]);
    expect(idsFor(page, viewer("cosmetics", new Set([PERMISSIONS.inventoryAdjust])))).toEqual([]);
    expect(tourById("accounting.cosmetics.specialized")?.route).toBe("/accounting/cosmetics");
  });

  it("limits sensitive Cosmetics tour steps to matching inventory and report permissions", () => {
    const page = "page:/accounting/cosmetics";
    const viewOnly = toursForViewer(page, viewer("cosmetics", new Set([PERMISSIONS.inventoryView])))[0];
    expect(viewOnly.steps.map((step) => step.id)).toEqual(["welcome", "tabs"]);
    const canSeeExpiry = toursForViewer(
      page,
      viewer("cosmetics", new Set([PERMISSIONS.inventoryView, PERMISSIONS.reportsView])),
    )[0];
    expect(canSeeExpiry.steps.map((step) => step.id)).toEqual(["welcome", "tabs", "expiry", "reports"]);
    const editor = toursForViewer(
      page,
      viewer("cosmetics", new Set([PERMISSIONS.inventoryView, PERMISSIONS.inventoryAdjust])),
    )[0];
    expect(editor.steps.map((step) => step.id)).toEqual([
      "welcome", "tabs", "batch-receipt", "switch-tab", "brand", "matrix",
      "compliance", "tester", "barcodes",
    ]);
    const all = toursForViewer(page, viewer("cosmetics"))[0];
    expect(all.steps).toHaveLength(11);
    expect(all.steps.filter((step) => step.kind === "spotlight").length).toBe(9);
    // Read-only members must not be able to claim hidden write steps as seen.
    expect(applyTourEvent(viewOnly, null, { type: "step_seen", stepId: "tester" }, T1)).toEqual({
      ok: false, error: "unknown_step",
    });
  });

  it("does not request inventory-system or feature facts for the Cosmetics tour", () => {
    expect(tourFactsNeeded(toursForPage("page:/accounting/cosmetics"))).toEqual({
      features: false, inventorySystem: false,
    });
  });

  it("gives the accounting home the staff tour exactly when the page draws the staff overview", () => {
    for (const industry of INDUSTRIES) {
      expect(idsFor("page:/accounting/overview", viewer(industry))).toEqual(["accounting.overview.ledger"]);
      expect(idsFor("page:/accounting/overview", viewer(industry, withoutLedger))).toEqual(["accounting.overview.staff"]);
      expect(idsFor("page:/accounting/overview", viewer(industry, noPermission))).toEqual(["accounting.overview.staff"]);
      // Ledger switched off for the business: the page falls back to the staff overview.
      expect(
        idsFor("page:/accounting/overview", viewer(industry, everyPermission, { features: { ledger: false } })),
      ).toEqual(["accounting.overview.staff"]);
    }
  });

  it("never describes the café till to an invoice trade, or the invoice screen to a café", () => {
    for (const industry of INDUSTRIES) {
      const ids = idsFor("page:/accounting/pos", viewer(industry));
      expect(ids.length, industry).toBe(1);
      if (industry === "food_service") expect(ids).toEqual(["accounting.pos.order-ticket"]);
      else if ((SERVICE_INVOICE_INDUSTRIES as readonly string[]).includes(industry)) {
        expect(ids).toEqual(["accounting.pos.service-invoice"]);
      } else expect(ids).toEqual(["accounting.pos.invoice"]);
      // The till needs both of its permissions.
      expect(idsFor("page:/accounting/pos", viewer(industry, new Set([PERMISSIONS.ordersCreate])))).toEqual([]);
    }
  });

  it("offers the barcode step only to trades whose invoice screen draws the scan field", () => {
    for (const industry of INDUSTRIES) {
      const [tour] = toursForViewer("page:/accounting/pos", viewer(industry));
      const hasStep = tour.steps.some((step) => step.id === "barcode");
      expect(hasStep, industry).toBe(tour.id === "accounting.pos.invoice" && hasCapability(industry, "barcode"));
    }
  });

  it("describes the café till's discount only to a member who can discount", () => {
    const withDiscount = toursForViewer("page:/accounting/pos", viewer("food_service"))[0];
    const withoutDiscount = toursForViewer(
      "page:/accounting/pos",
      viewer("food_service", new Set([PERMISSIONS.ordersCreate, PERMISSIONS.paymentsTake])),
    )[0];
    expect(withDiscount.steps.some((step) => step.id === "discount")).toBe(true);
    expect(withoutDiscount.steps.some((step) => step.id === "discount")).toBe(false);
  });

  it("matches the inventory tour to the stock model and costing system of the business", () => {
    for (const industry of INDUSTRIES) {
      for (const inventorySystem of ["perpetual", "periodic"] as TourInventorySystem[]) {
        const ids = idsFor("page:/accounting/inventory", viewer(industry, everyPermission, { inventorySystem }));
        if (hasModule(industry, "inventory")) {
          expect(ids, industry).toEqual([
            inventorySystem === "periodic"
              ? "accounting.inventory.food-service-periodic"
              : "accounting.inventory.food-service",
          ]);
        } else if (hasModule(industry, "stock")) {
          expect(ids, industry).toEqual(["accounting.inventory.retail"]);
        } else {
          expect(ids, industry).toEqual([]);
        }
      }
    }
  });

  it("does not offer the café inventory tour when the inventory feature is off", () => {
    const off = viewer("food_service", everyPermission, { features: { inventory: false } });
    expect(idsFor("page:/accounting/inventory", off)).toEqual([]);
  });

  it("never mentions controls of the other costing system", () => {
    const text = (id: string) => JSON.stringify(tourById(id)!.steps.map((step) => [step.title, step.body]));
    // Perpetual-only instruments are named as absent, never as available, in the periodic tour.
    expect(text("accounting.inventory.food-service-periodic")).not.toContain("ثبت رسید انبار/حواله» برای ورود");
    expect(text("accounting.inventory.food-service")).not.toContain("بستن دوره (ادواری)");
  });

  it("serves the products workspace pages only to the trades that have it, with the page's permission", () => {
    const pages = ARTICLE_PAGES.filter((page) => page.startsWith("page:/accounting/products/"));
    for (const industry of INDUSTRIES) {
      const inWorkspace = (PRODUCT_WORKSPACE_INDUSTRIES as readonly string[]).includes(industry);
      for (const page of pages) {
        expect(idsFor(page, viewer(industry)).length, `${industry} ${page}`).toBe(inWorkspace ? 1 : 0);
        expect(idsFor(page, viewer(industry, noPermission)), `${industry} ${page}`).toEqual([]);
      }
    }
    // Adding a product writes the catalogue, so it needs the write permission, not just the view.
    const viewOnly = new Set<string>([PERMISSIONS.inventoryView]);
    expect(idsFor("page:/accounting/products/new", viewer("cosmetics", viewOnly))).toEqual([]);
    expect(idsFor("page:/accounting/products/prices", viewer("cosmetics", viewOnly)).length).toBe(1);
  });

  it("filters the steps a member's permissions do not reach out of THEIR tour", () => {
    const viewOnly = new Set<string>([PERMISSIONS.inventoryView]);
    const readOnly = toursForViewer("page:/accounting/products/prices", viewer("cosmetics", viewOnly))[0];
    const editor = toursForViewer("page:/accounting/products/prices", viewer("cosmetics"))[0];
    const editOnly = ["edit-tools", "save-rules"];
    for (const id of editOnly) {
      expect(readOnly.steps.map((step) => step.id)).not.toContain(id);
      expect(editor.steps.map((step) => step.id)).toContain(id);
    }
    // What the read-only member is shown is also what they are asked to finish.
    const summary = tourSummary(readOnly, null);
    expect(summary.stepCount).toBe(readOnly.steps.length);
    expect(summary.stepCount).toBeLessThan(tourSummary(editor, null).stepCount);
    const finished = readOnly.steps.reduce<StoredTourProgress | null>(
      (progress, step) => {
        const result = applyTourEvent(readOnly, progress, { type: "step_seen", stepId: step.id }, T1);
        if (!result.ok) throw new Error(result.error);
        return result.progress;
      },
      null,
    );
    const done = applyTourEvent(readOnly, finished, { type: "complete" }, T1);
    expect(done.ok).toBe(true);
    // A step that exists only for editors is not a valid event for a read-only member.
    expect(applyTourEvent(readOnly, null, { type: "step_seen", stepId: "save-rules" }, T1)).toEqual({
      ok: false,
      error: "unknown_step",
    });
  });

  it("returns null for a tour whose every step is filtered out", () => {
    const only: TourDefinition = {
      ...tour,
      steps: [{ id: "a", kind: "explain", title: "x", body: ".", eligibility: { permissions: [PERMISSIONS.ledgerView] } }],
    };
    expect(tourForViewer(only, viewer(null, noPermission))).toBeNull();
    expect(tourForViewer(only, viewer(null))?.steps).toHaveLength(1);
  });

  it("fails closed when a tour asks about a fact the server did not read", () => {
    const ledger = tourById("accounting.overview.ledger")!;
    const unread: TourViewer = { permissions: everyPermission, industry: "food_service" };
    expect(isTourEligible(ledger, unread)).toBe(false);
    const staff = tourById("accounting.overview.staff")!;
    expect(isTourEligible(staff, { permissions: withoutLedger, industry: "food_service" })).toBe(true);
    expect(isTourEligible(staff, unread)).toBe(false);
    const periodic = tourById("accounting.inventory.food-service-periodic")!;
    expect(isTourEligible(periodic, { ...viewer("food_service"), inventorySystem: undefined })).toBe(false);
  });

  it("reads optional facts only for the tours that ask for them", () => {
    expect(tourFactsNeeded(toursForPage("page:/accounting/products"))).toEqual({ features: false, inventorySystem: false });
    expect(tourFactsNeeded(toursForPage("page:/accounting/overview"))).toEqual({ features: true, inventorySystem: false });
    expect(tourFactsNeeded(toursForPage("page:/accounting/inventory"))).toEqual({ features: true, inventorySystem: true });
    expect(tourFactsNeeded(toursForPage("page:/accounting/pos"))).toEqual({ features: false, inventorySystem: false });
  });

  it("derives the service-invoice trades from the profile the same way the till does", () => {
    const service = INDUSTRIES.filter((industry) => idsFor("page:/accounting/pos", viewer(industry))[0] === "accounting.pos.service-invoice");
    expect([...service].sort()).toEqual([...SERVICE_INVOICE_INDUSTRIES].sort());
  });

  it("opens every tour with a plain explanation, so a missing first anchor cannot be the first thing a member meets", () => {
    for (const def of TOURS) {
      expect(def.steps[0].kind, def.id).toBe("explain");
    }
  });
});
