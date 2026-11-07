/**
 * Issue #972 — the universal baseline tour layer.
 *
 * The owner's decision (2026-11-06) is that guidance must not depend on
 * somebody hand-writing a `TOURS` entry per page: a registered page with
 * canonical route and metadata gains basic guidance by itself, an authored
 * tour overrides it rather than competing with it, and nothing the baseline
 * cannot prove is ever highlighted.
 */
import { describe, expect, it } from "vitest";
import { KNOWLEDGE_PAGES, type KnowledgePage } from "./knowledge-base";
import {
  BASELINE_TOUR_PREFIX,
  PAGE_TOUR_REGIONS,
  baselinePageForId,
  baselineTourForPage,
  baselineTourIdForRoute,
  isBaselineTourId,
  pageTourCandidates,
  regionsForPage,
  tourDefinitionById,
  type PageTourRegion,
} from "./tour-baseline";
import { tourCoverage } from "./tour-coverage";
import {
  TOURS,
  TOUR_ANCHORS,
  applyTourEvent,
  tourForViewer,
  tourProgressView,
  toursForPage,
  validateTours,
  type StoredTourProgress,
  type TourDefinition,
  type TourProgressEvent,
  type TourViewer,
} from "./tours";

const T1 = "2026-11-06T09:05:00.000Z";

/** A page nobody wrote a catalogue entry for — the acceptance case, in code. */
const NEW_PAGE: KnowledgePage = {
  key: "page:/accounting/newly-registered",
  route: "/accounting/newly-registered",
  label: "صفحهٔ تازه",
  group: "حسابداری",
};

const BASELINE_ID = baselineTourIdForRoute(NEW_PAGE.route);

function run(definition: TourDefinition, events: TourProgressEvent[], from: StoredTourProgress | null = null) {
  let progress = from;
  for (const event of events) {
    const result = applyTourEvent(definition, progress, event, T1);
    if (!result.ok) throw new Error(result.error);
    progress = result.progress;
  }
  return progress;
}

describe("automatic baseline tours", () => {
  it("gives every registered page exactly one tour when no authored tour owns it", () => {
    for (const page of KNOWLEDGE_PAGES) {
      const candidates = pageTourCandidates(page.key);
      const authored = toursForPage(page.key);
      expect(candidates.length, page.key).toBeGreaterThan(0);
      if (authored.length > 0) {
        expect(candidates.map((tour) => tour.id), page.key).toEqual(authored.map((tour) => tour.id));
      } else {
        expect(candidates, page.key).toHaveLength(1);
        expect(isBaselineTourId(candidates[0].id), page.key).toBe(true);
      }
    }
  });

  it("needs no catalogue entry for a page registered today", () => {
    const tour = baselineTourForPage(NEW_PAGE);
    expect(tour.id).toBe(BASELINE_ID);
    expect(tour.pageKey).toBe(NEW_PAGE.key);
    expect(tour.route).toBe(NEW_PAGE.route);
    expect(toursForPage(NEW_PAGE.key)).toEqual([]);
    expect(validateTours([tour])).toEqual([]);
  });

  it("is a valid, uniquely identified catalogue for the whole registry", () => {
    const baselines = KNOWLEDGE_PAGES.filter((page) => toursForPage(page.key).length === 0).map((page) =>
      baselineTourForPage(page),
    );
    expect(validateTours(baselines)).toEqual([]);
    const ids = baselines.map((tour) => tour.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
    // A baseline id is namespaced, so it can never be confused with — or
    // collide with — a hand-authored id.
    const authoredIds = new Set(TOURS.map((tour) => tour.id));
    for (const id of ids) {
      expect(isBaselineTourId(id)).toBe(true);
      expect(id.startsWith(BASELINE_TOUR_PREFIX)).toBe(true);
      expect(authoredIds.has(id), id).toBe(false);
    }
  });

  it("describes only what metadata can prove, and highlights only declared regions", () => {
    const bare = baselineTourForPage(NEW_PAGE, {});
    expect(bare.steps.some((step) => step.kind === "spotlight")).toBe(false);
    expect(bare.steps[0].kind).toBe("explain");
    for (const step of bare.steps) {
      if (step.kind === "explain") expect(step.anchor).toBeUndefined();
      else expect(step.anchor).toBeDefined();
    }
    // Route, title and purpose come from the registry, never from guessed copy.
    expect(bare.title).toContain(NEW_PAGE.label);
    expect(bare.steps.some((step) => step.body.includes(NEW_PAGE.route))).toBe(true);
    expect(bare.eligibility).toEqual({});
  });

  it("turns a declared region into a spotlight step, once, with a registered anchor", () => {
    const regions: Record<string, readonly PageTourRegion[]> = {
      "*": [{ anchor: TOUR_ANCHORS.pageHeader, title: "سرصفحه", body: "شرح" }],
      [NEW_PAGE.key]: [{ anchor: TOUR_ANCHORS.pageHeader, title: "سرصفحهٔ این صفحه", body: "شرح" }],
    };
    const tour = baselineTourForPage(NEW_PAGE, regions);
    const spotlights = tour.steps.filter((step) => step.kind === "spotlight");
    expect(spotlights).toHaveLength(1);
    expect(spotlights[0]).toMatchObject({ anchor: TOUR_ANCHORS.pageHeader, title: "سرصفحهٔ این صفحه" });
    const registered = new Set<string>(Object.values(TOUR_ANCHORS));
    for (const step of tour.steps) {
      if (step.anchor) expect(registered.has(step.anchor), step.id).toBe(true);
    }
    // The shared region applies to every page without repeating per page.
    expect(regionsForPage("page:/crm/audit").map((region) => region.anchor)).toEqual([
      TOUR_ANCHORS.pageHeader,
    ]);
  });

  it("keeps an authored tour as the only guide for its page, and refuses a baseline id there", () => {
    const products = "page:/accounting/products";
    expect(toursForPage(products).length).toBeGreaterThan(0);
    expect(pageTourCandidates(products).every((tour) => !isBaselineTourId(tour.id))).toBe(true);
    expect(tourDefinitionById(baselineTourIdForRoute("/accounting/products"))).toBeUndefined();
  });

  it("resolves a baseline id to its page for playback and progress writes", () => {
    const page = KNOWLEDGE_PAGES.find((candidate) => toursForPage(candidate.key).length === 0)!;
    const id = baselineTourIdForRoute(page.route);
    expect(baselinePageForId(id)?.key).toBe(page.key);
    expect(tourDefinitionById(id)?.pageKey).toBe(page.key);
    expect(tourDefinitionById("baseline.nowhere")).toBeUndefined();
    expect(tourDefinitionById("nope")).toBeUndefined();
  });

  it("is only offered to a viewer when the page itself has no authored catalogue", () => {
    const viewer: TourViewer = { permissions: new Set(), industry: null };
    const authored = pageTourCandidates("page:/accounting/products").flatMap(
      (tour) => tourForViewer(tour, viewer) ?? [],
    );
    // The products tour is gated: an ineligible member gets nothing rather than
    // a baseline describing a screen its instructions are gated on.
    expect(authored).toEqual([]);
    const baseline = pageTourCandidates("page:/crm/audit").flatMap(
      (tour) => tourForViewer(tour, viewer) ?? [],
    );
    expect(baseline).toHaveLength(1);
    expect(isBaselineTourId(baseline[0].id)).toBe(true);
  });

  it("records progress with the same rules as any other tour", () => {
    const tour = baselineTourForPage(NEW_PAGE);
    const ids = tour.steps.map((step) => step.id);

    const started = run(tour, [{ type: "start" }]);
    expect(started?.currentStepId).toBe(ids[0]);

    const partial = run(tour, [{ type: "step_seen", stepId: ids[0] }], started);
    expect(tourProgressView(tour, partial)).toMatchObject({
      status: "in_progress",
      seenCount: 1,
      totalSteps: ids.length,
    });

    // Skipped is not seen: completion waits for the last step.
    const forced = applyTourEvent(tour, partial, { type: "complete" }, T1);
    expect(forced).toEqual({ ok: false, error: "steps_unseen" });

    const finished = run(
      tour,
      [
        ...ids.slice(1).map((stepId) => ({ type: "step_seen", stepId }) as TourProgressEvent),
        { type: "complete" },
      ],
      partial,
    );
    expect(tourProgressView(tour, finished)).toMatchObject({ status: "completed", percent: 100 });
  });
});

describe("the coverage audit", () => {
  const report = tourCoverage();

  it("lists every registered page once, with no contract issue", () => {
    expect(report.pages.map((row) => row.pageKey)).toEqual(KNOWLEDGE_PAGES.map((page) => page.key));
    expect(report.issues).toEqual([]);
    expect(report.advancedPages + report.baselinePages).toBe(KNOWLEDGE_PAGES.length);
    expect(report.pages.every((row) => row.stepCount > 0)).toBe(true);
  });

  it("reports the authored pages as advanced and the rest as the editorial backlog", () => {
    const authoredPages = new Set(TOURS.map((tour) => tour.pageKey));
    for (const row of report.pages) {
      expect(row.kind).toBe(authoredPages.has(row.pageKey) ? "advanced" : "baseline");
      if (row.kind === "advanced") expect(row.tourIds.length).toBeGreaterThan(0);
      else expect(row.tourIds).toEqual([]);
    }
    expect(report.editorialGaps).toEqual(
      report.pages.filter((row) => row.kind === "baseline").map((row) => row.pageKey),
    );
    expect(report.authoredTours).toBe(TOURS.length);
  });

  it("never flags a page the baseline already covers as missing", () => {
    for (const row of report.pages) {
      expect(row.primaryTourId.length).toBeGreaterThan(0);
    }
    // The default region map declares the shared header, so no page is left
    // without at least one real spotlight.
    expect(report.pages.every((row) => row.spotlightCount > 0)).toBe(true);
    expect(PAGE_TOUR_REGIONS["*"]?.length).toBeGreaterThan(0);
  });

  it("names a broken contract instead of hiding it", () => {
    const broken: TourDefinition = {
      id: "accounting.ghost",
      version: 1,
      pageKey: "page:/accounting/ghost",
      route: "/accounting/ghost",
      title: "تور ناموجود",
      description: "…",
      eligibility: {},
      steps: [{ id: "a", kind: "explain", title: "الف", body: "." }],
    };
    const badRegions: Record<string, readonly PageTourRegion[]> = {
      "page:/accounting/ghost": [{ anchor: "not.registered" as never, title: "", body: "" }],
      "*": [{ anchor: TOUR_ANCHORS.pageHeader, title: "سرصفحه", body: "شرح" }],
    };
    const issues = tourCoverage([...TOURS, broken], badRegions).issues;
    expect(issues.some((issue) => issue.includes("page page:/accounting/ghost is not registered"))).toBe(true);
    expect(issues.some((issue) => issue.includes("unregistered page"))).toBe(true);
    expect(issues.some((issue) => issue.includes("not.registered is not registered"))).toBe(true);
    expect(issues.some((issue) => issue.includes("needs a title and a body"))).toBe(true);
  });

  it("keeps progress keyed on a stable id across a metadata-only change", () => {
    const tour = baselineTourForPage(NEW_PAGE);
    const seen = run(tour, [{ type: "start" }]);
    const relabelled = baselineTourForPage({ ...NEW_PAGE, label: "صفحهٔ تازه (نام تازه)" });
    expect(relabelled.id).toBe(tour.id);
    expect(relabelled.steps.map((step) => step.id)).toEqual(tour.steps.map((step) => step.id));
    expect(seen?.currentStepId).toBe(tour.steps[0].id);
  });
});
