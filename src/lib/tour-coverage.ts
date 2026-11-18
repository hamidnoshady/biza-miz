/**
 * Coverage audit for the guided-tour system (issue #972).
 *
 * The epic asks for one report that keeps three different things apart:
 *
 *  - **learning progress** — what a member has seen. That is
 *    `tour_member_progress` and `tourProgressView`, not this file;
 *  - **content coverage** — how much of the product has a real authored tour.
 *    That is this file, and it is the only place that answers it;
 *  - **business setup readiness** — the setup wizard's `setup.progress`.
 *
 * Every page in the canonical `KNOWLEDGE_PAGES` registry is listed exactly
 * once, with the tour its «آموزش» button offers: `advanced` when an authored
 * tour owns the page, `baseline` when the page falls back to the automatic,
 * metadata-derived introduction (`tour-baseline.ts`). A page can never be
 * silently absent — that is the point of the baseline — so "missing" here
 * means an *editorial* gap (a page still on its baseline) and "invalid" means
 * a broken contract (an anchor nobody registers, a region for a page that does
 * not exist, a tour attached to an unregistered page, a duplicate id).
 *
 * Pure and framework-free, so the same report drives the unit tests, the
 * `npm run tours:audit` script and — when the Studio ships — its page list.
 */
import { KNOWLEDGE_PAGES } from "./knowledge-base";
import {
  PAGE_TOUR_REGIONS,
  baselineTourForPage,
  baselineTourIdForRoute,
  regionsForPage,
  type PageTourRegion,
} from "./tour-baseline";
import { mergePublishedTours } from "./tour-studio";
import { TOURS, TOUR_ANCHORS, validateTours, type TourDefinition } from "./tours";

export type TourCoverageKind = "advanced" | "baseline";

export interface TourCoverageRow {
  pageKey: string;
  route: string;
  label: string;
  group: string;
  kind: TourCoverageKind;
  /** The authored tours on this page (code and published); empty for a baseline page. */
  tourIds: string[];
  /** Of those, the ones the super-admin published from the console (migration 0288). */
  studioTourIds: string[];
  /** The tour a fully eligible member is offered, and the one progress is keyed on. */
  primaryTourId: string;
  stepCount: number;
  /** How many steps of the primary tour point at a registered anchor. */
  spotlightCount: number;
  /** Registered anchors the primary tour points at, in step order. */
  anchors: string[];
  /** Steps that are explanation-only (no anchor, no action, no hand-off). */
  explanationCount: number;
  /** Steps that ask for a server-verified real action. */
  actionCount: number;
  /** Steps that hand the member to another page. */
  navigateCount: number;
  /** True when the primary tour can point at at least one real UI region. */
  hasSpotlight: boolean;
  /** Problems with this page's coverage; empty means publishable. */
  issues: string[];
}

export interface TourCoverageReport {
  pages: TourCoverageRow[];
  /** Pages with an authored tour. */
  advancedPages: number;
  /** Pages on the automatic baseline — i.e. the editorial backlog. */
  baselinePages: number;
  authoredTours: number;
  /** Published console tours included in this report. */
  studioTours: number;
  /** Steps across every tour the button can offer, baseline tours included. */
  steps: number;
  /** Pages whose primary tour points at at least one real UI region. */
  spotlightPages: number;
  /** Pages whose primary tour is explanation-only (the editorial backlog). */
  explanationOnlyPages: number;
  /** How many steps across the offered tours point at an anchor. */
  spotlightSteps: number;
  /** How many steps across the offered tours ask for a verified real action. */
  actionSteps: number;
  /** How many steps hand the member to another registered page. */
  navigateSteps: number;
  /** Catalogue-level contract problems. Empty means the whole registry is consistent. */
  issues: string[];
  /** Page keys that still need an authored tour, in registry order. */
  editorialGaps: string[];
  /** Page keys with no tour at all. A contract failure when non-empty. */
  uncoveredPages: string[];
  /** Authored tours attached to a page the registry no longer knows. */
  staleTourIds: string[];
}

function anchorsOf(tour: TourDefinition): string[] {
  return tour.steps.flatMap((step) => (step.anchor ? [step.anchor] : []));
}

/**
 * The report. Both parameters exist so a test can audit an injected catalogue
 * and region map — the defaults are the live registry and declarations.
 */
export function tourCoverage(
  tours: readonly TourDefinition[] = TOURS,
  regions: Readonly<Record<string, readonly PageTourRegion[]>> = PAGE_TOUR_REGIONS,
  published: readonly TourDefinition[] = [],
): TourCoverageReport {
  const issues: string[] = [...validateTours(tours)];
  const registeredAnchors = new Set<string>(Object.values(TOUR_ANCHORS));
  const pagesByKey = new Map(KNOWLEDGE_PAGES.map((page) => [page.key, page]));

  // Contract checks that `validateTours` cannot see: authored tours attached to
  // a page nobody registered, and declared regions for pages or anchors that do
  // not exist.
  for (const tour of tours) {
    if (!pagesByKey.has(tour.pageKey)) issues.push(`${tour.id}: page ${tour.pageKey} is not registered`);
  }
  for (const tour of published) {
    if (!pagesByKey.has(tour.pageKey)) {
      issues.push(`${tour.id}: published tour points at unregistered page ${tour.pageKey}`);
    }
  }
  for (const [pageKey, declared] of Object.entries(regions)) {
    if (pageKey !== "*" && !pagesByKey.has(pageKey)) {
      issues.push(`${pageKey}: region declared for an unregistered page`);
    }
    for (const region of declared) {
      if (!registeredAnchors.has(region.anchor)) {
        issues.push(`${pageKey}: region anchor ${region.anchor} is not registered`);
      }
      if (!region.title.trim() || !region.body.trim()) {
        issues.push(`${pageKey}: region ${region.anchor} needs a title and a body`);
      }
    }
  }

  const authoredByPage = new Map<string, TourDefinition[]>();
  for (const tour of tours) {
    const list = authoredByPage.get(tour.pageKey) ?? [];
    list.push(tour);
    authoredByPage.set(tour.pageKey, list);
  }

  const rows = KNOWLEDGE_PAGES.map((page): TourCoverageRow => {
    const publishedForPage = published.filter((tour) => tour.pageKey === page.key);
    // A published console tour replaces a code tour with the same id and is
    // otherwise added, exactly as the member lookup composes the catalogue.
    const authored = mergePublishedTours(authoredByPage.get(page.key) ?? [], publishedForPage);
    const baseline = baselineTourForPage(page, regions);
    // A console-published tour is the editorial head of the page; a code tour
    // remains a valid fallback and is still offered beside it.
    const primary =
      authored.find((tour) => publishedForPage.some((entry) => entry.id === tour.id)) ??
      authored[0] ??
      baseline;
    const pageIssues: string[] = [];
    if (authored.length === 0 && regionsForPage(page.key, regions).length === 0) {
      pageIssues.push("no declared region: the baseline is explanation-only");
    }
    return {
      pageKey: page.key,
      route: page.route,
      label: page.label,
      group: page.group,
      kind: authored.length > 0 ? "advanced" : "baseline",
      tourIds: authored.map((tour) => tour.id),
      studioTourIds: publishedForPage.map((tour) => tour.id),
      primaryTourId: primary.id,
      stepCount: primary.steps.length,
      spotlightCount: anchorsOf(primary).length,
      anchors: anchorsOf(primary),
      explanationCount: primary.steps.filter((step) => step.kind === "explain").length,
      actionCount: primary.steps.filter((step) => step.kind === "action").length,
      navigateCount: primary.steps.filter((step) => step.kind === "navigate").length,
      // The shared page header is the universal fallback, not a meaningful
      // spotlight of the page's own work: a page that only points at it is
      // still an editorial gap, and the report says so.
      hasSpotlight: anchorsOf(primary).some((anchor) => anchor !== TOUR_ANCHORS.pageHeader),
      issues: pageIssues,
    };
  });

  // Baseline ids must be unique and must not collide with an authored id: both
  // are stored in one progress table keyed on the tour id alone.
  const seenIds = new Set<string>();
  for (const row of rows) {
    const id = baselineTourIdForRoute(row.route);
    if (seenIds.has(id)) issues.push(`${id}: two registered pages produce the same baseline id`);
    seenIds.add(id);
  }
  for (const tour of tours) {
    if (seenIds.has(tour.id)) issues.push(`${tour.id}: authored id collides with a baseline id`);
  }
  issues.push(...validateTours(rows.map((row) => baselineTourForPage(pagesByKey.get(row.pageKey)!))));

  // Two authored tours may share a page on purpose (the ledger and the staff
  // overview); the button then offers both, so the totals count every tour it
  // can offer rather than only the row's primary one.
  const offered = KNOWLEDGE_PAGES.flatMap((page) => {
    const authored = mergePublishedTours(
      authoredByPage.get(page.key) ?? [],
      published.filter((tour) => tour.pageKey === page.key),
    );
    return authored.length > 0 ? authored : [baselineTourForPage(page, regions)];
  });
  const offeredSteps = offered.reduce((total, tour) => total + tour.steps.length, 0);
  const allOfferedSteps = offered.flatMap((tour) => [...tour.steps]);

  return {
    pages: rows,
    advancedPages: rows.filter((row) => row.kind === "advanced").length,
    baselinePages: rows.filter((row) => row.kind === "baseline").length,
    authoredTours: tours.length,
    studioTours: published.length,
    steps: offeredSteps,
    spotlightPages: rows.filter((row) => row.hasSpotlight).length,
    explanationOnlyPages: rows.filter((row) => !row.hasSpotlight).length,
    spotlightSteps: allOfferedSteps.filter((step) => Boolean(step.anchor)).length,
    actionSteps: allOfferedSteps.filter((step) => step.kind === "action").length,
    navigateSteps: allOfferedSteps.filter((step) => step.kind === "navigate").length,
    issues,
    editorialGaps: rows.filter((row) => row.kind === "baseline").map((row) => row.pageKey),
    uncoveredPages: rows.filter((row) => row.stepCount === 0).map((row) => row.pageKey),
    staleTourIds: tours.filter((tour) => !pagesByKey.has(tour.pageKey)).map((tour) => tour.id),
  };
}
