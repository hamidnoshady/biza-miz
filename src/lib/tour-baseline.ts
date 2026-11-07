/**
 * Universal, metadata-driven baseline tours (issue #972, owner decision
 * 2026-11-06).
 *
 * The `TOURS` catalogue in `tours.ts` is authored: a person writes the steps
 * for one screen and reviews them. That is the right shape for an advanced
 * walkthrough, and the wrong shape for the platform's ~100 registered pages —
 * a page whose «آموزش» button has nothing behind it is a dead end, and
 * "nobody wrote a tour for it" is not a reason to teach a member nothing.
 *
 * So every page in the canonical `KNOWLEDGE_PAGES` registry gets a **baseline
 * tour** derived from metadata the platform already owns:
 *
 *  - the page's canonical route and its human-readable label (`KNOWLEDGE_PAGES`);
 *  - the navigation group it is filed under — the same grouping the Knowledge
 *    Center and the super-admin page picker show;
 *  - any **declared safe region** (`PAGE_TOUR_REGIONS`), i.e. a registered
 *    `data-tour-id` anchor an owning shared component really renders.
 *
 * A new registered page therefore gains basic guidance with no `TOURS` entry,
 * no migration and no PR to this file. Nothing is guessed: a baseline tour
 * describes only the page as the registry describes it, never a control the
 * tour cannot prove is there. When the page has no declared region the tour is
 * explanation-only, and `tour-coverage.ts` reports it as an editorial gap
 * rather than pretending the page is covered by a real walkthrough.
 *
 * Precedence is the whole point of "one guide, no duplicates":
 *
 *  - a page that has **any** authored tour belongs to the authored catalogue.
 *    A member who is eligible gets that tour; a member who is not gets
 *    nothing — a baseline "about" a screen whose instructions are gated would
 *    describe screens they may not be allowed to see.
 *  - a page with **no** authored tour gets exactly one baseline tour: the same
 *    runtime, the same progress table, the same button.
 *
 * Client-safe: pure data, no database and no DOM.
 */
import { KNOWLEDGE_PAGES, knowledgePage, type KnowledgePage } from "./knowledge-base";
import {
  TOUR_ANCHORS,
  tourById,
  toursForPage,
  type TourAnchor,
  type TourDefinition,
  type TourStep,
} from "./tours";

/** Baseline ids are namespaced so they can never be mistaken for authored ones. */
export const BASELINE_TOUR_PREFIX = "baseline.";

/**
 * The baseline content revision. Bump it only when the *generated copy* changes
 * shape; adding a step for one page does not need a bump — a step added later
 * is simply unseen (see `reconcileTourProgress`), so a finished member is asked
 * about the new step instead of being reset.
 */
export const BASELINE_TOUR_VERSION = 1;

/**
 * A region of a page a baseline tour may point at, declared by a reviewer next
 * to the anchor the owning component renders. `anchor` must be registered in
 * `TOUR_ANCHORS`; `tour-baseline.test.ts` fails otherwise.
 */
export interface PageTourRegion {
  anchor: TourAnchor;
  title: string;
  body: string;
}

/**
 * Declared regions, keyed by page key. `"*"` applies to every page that has no
 * authored tour — used for the shared page header that `page-chrome.tsx`
 * renders on the pages that adopt it. A page-specific entry wins over the
 * wildcard for the same anchor, so one page can reword a shared region.
 *
 * Adding a region is how a page gains a real spotlight without a `TOURS`
 * entry; leaving it out is honest, not a bug: the baseline then explains the
 * page instead of highlighting a control nobody declared.
 */
export const PAGE_TOUR_REGIONS: Readonly<Record<string, readonly PageTourRegion[]>> = {
  "*": [
    {
      anchor: TOUR_ANCHORS.pageHeader,
      title: "سرصفحهٔ صفحه",
      body:
        "عنوان صفحه، توضیح کوتاه آن و کارهای اصلی صفحه بالای آن چیده شده‌اند؛ دکمهٔ «آموزش» هم در همین نوار است.",
    },
  ],
};

/** The stable baseline id for a canonical route: `/accounting/pos` → `baseline.accounting.pos`. */
export function baselineTourIdForRoute(route: string): string {
  const slug = route
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".");
  return `${BASELINE_TOUR_PREFIX}${slug}`;
}

export function isBaselineTourId(id: string): boolean {
  return id.startsWith(BASELINE_TOUR_PREFIX);
}

/**
 * Every region that applies to a page, page-specific first and the wildcard's
 * remaining anchors after it. One anchor is described once — a page may reword
 * a shared region, not show it twice.
 */
export function regionsForPage(
  pageKey: string,
  regions: Readonly<Record<string, readonly PageTourRegion[]>> = PAGE_TOUR_REGIONS,
): PageTourRegion[] {
  const own = regions[pageKey] ?? [];
  const seen = new Set<string>(own.map((region) => region.anchor));
  const shared = (regions["*"] ?? []).filter((region) => !seen.has(region.anchor));
  return [...own, ...shared];
}

/**
 * The baseline tour for one registered page. Deterministic: same page and same
 * regions, same definition — progress is keyed on the ids it produces.
 */
export function baselineTourForPage(
  page: KnowledgePage,
  regions: Readonly<Record<string, readonly PageTourRegion[]>> = PAGE_TOUR_REGIONS,
): TourDefinition {
  const declared = regionsForPage(page.key, regions);
  const steps: TourStep[] = [
    {
      id: "intro",
      kind: "explain",
      title: `آشنایی با ${page.label}`,
      body: `این صفحه «${page.label}» است، در گروه «${page.group}». این یک معرفی خودکار از خود صفحه است: چیزی را تغییر نمی‌دهد و روی هیچ دکمه‌ای کار نمی‌کند.`,
    },
    ...declared.map(
      (region): TourStep => ({
        id: `region.${region.anchor}`,
        kind: "spotlight",
        anchor: region.anchor,
        title: region.title,
        body: region.body,
      }),
    ),
    {
      id: "where",
      kind: "explain",
      title: "جای این صفحه",
      body: `نشانی این صفحه ${page.route} است و در فهرست «${page.group}» می‌آید. هر بخشی که اینجا نمی‌بینید، در دسترسی نقش شما نیست؛ این معرفی چیزی بیش از آنچه می‌بینید توصیف نمی‌کند.`,
    },
    {
      id: "learn",
      kind: "explain",
      title: "راهنمای مکتوب",
      body: "در همین پنجره، «راهنمای پایگاه دانش» مقالهٔ منتشرشدهٔ این صفحه (یا صفحهٔ آموزشی بخش) را باز می‌کند. وقتی برای این صفحه یک تور گام‌به‌گام نوشته و منتشر شود، جای این معرفی خودکار را می‌گیرد.",
    },
  ];

  return {
    id: baselineTourIdForRoute(page.route),
    version: BASELINE_TOUR_VERSION,
    pageKey: page.key,
    route: page.route,
    title: `آشنایی با ${page.label}`,
    description:
      "معرفی خودکار این صفحه از فهرست صفحه‌های برنامه. تور گام‌به‌گام هنوز برای این صفحه نوشته نشده است؛ راهنمای مکتوبش در پایگاه دانش است.",
    eligibility: {},
    steps,
  };
}

/**
 * What the «آموزش» button's page lookup starts from: the authored catalogue
 * when the page has one, otherwise its single baseline tour.
 *
 * Callers still narrow the result per viewer with `tourForViewer`; this only
 * decides *which* catalogue owns the page, so a member is never offered a
 * baseline "alongside" an authored tour.
 */
export function pageTourCandidates(pageKey: string): TourDefinition[] {
  const authored = toursForPage(pageKey);
  if (authored.length > 0) return authored;
  const page = knowledgePage(pageKey);
  return page ? [baselineTourForPage(page)] : [];
}

const BASELINE_PAGE_BY_ID: ReadonlyMap<string, KnowledgePage> = new Map(
  KNOWLEDGE_PAGES.map((page) => [baselineTourIdForRoute(page.route), page]),
);

/** Pure lookup half of `tourDefinitionById`, exported for the coverage audit. */
export function baselinePageForId(id: string): KnowledgePage | undefined {
  return BASELINE_PAGE_BY_ID.get(id);
}

/**
 * The tour a client named, authored first and baseline second. A baseline id
 * for a page that has authored tours is unknown: the authored catalogue owns
 * that page, exactly as `pageTourCandidates` decides for the list.
 */
export function tourDefinitionById(id: string): TourDefinition | undefined {
  const authored = tourById(id);
  if (authored) return authored;
  if (!isBaselineTourId(id)) return undefined;
  const page = baselinePageForId(id);
  if (!page || toursForPage(page.key).length > 0) return undefined;
  return baselineTourForPage(page);
}
