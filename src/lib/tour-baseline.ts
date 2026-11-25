/**
 * Historical baseline definitions for the offline coverage audit and fixtures.
 * Member tour requests read published Studio revisions.
 */
import type { KnowledgePage } from "./knowledge-base";
import {
  TOUR_ANCHORS,
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

/**
 * Regions that apply to every page under a route prefix. The sidebar a shell
 * already draws is the region a navigation overview should point at, and it is
 * exactly the kind of reusable declaration the owner decision asked for: one
 * anchor on the owning component, one declaration per app, and every page in
 * that app gains a truthful spotlight without an entry per page.
 *
 * A page-specific entry wins over a prefix (same anchor is described once), and
 * the wildcard header remains the fallback for pages outside these apps.
 */
export const PAGE_TOUR_REGION_PREFIXES: ReadonlyArray<{
  prefix: string;
  regions: readonly PageTourRegion[];
}> = [
  {
    prefix: "/accounting",
    regions: [
      {
        anchor: TOUR_ANCHORS.accountingSectionNav,
        title: "منوی فضای کار حسابداری",
        body:
          "از این منو بین بخش‌های حسابداری جابه‌جا می‌شوید: فروش و سفارش‌ها، صندوق، خرید و انبار، محصولات، عملیات و گزارش‌ها. فقط بخش‌هایی که برای نقش و صنف شما مجاز است در این فهرست دیده می‌شود.",
      },
    ],
  },
  {
    prefix: "/crm",
    regions: [
      {
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی CRM",
        body:
          "این منو بخش‌های CRM را نگه می‌دارد: مشتریان، فرصت‌ها، کارها و پیگیری‌ها، تیکت‌ها، بخش‌بندی و کیفیت داده. جایی که هستید با نشانگر انتخاب شده است و بقیه بخش‌ها یک کلیک دورترند.",
      },
    ],
  },
  {
    prefix: "/growth",
    regions: [
      {
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی رشد و بازاریابی",
        body:
          "از این منو به مخاطبان، کمپین‌ها، پیام‌رسانی، کارت هدیه، وفاداری، پورسانت و تنظیمات رشد می‌رسید. آیتم فعال همان صفحه‌ای است که باز کرده‌اید.",
      },
    ],
  },
  {
    prefix: "/websites",
    regions: [
      {
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی مدیریت وب‌سایت",
        body:
          "این منو دو مدیر سایت را کنار هم نگه می‌دارد: سایت بیزامیز (CMS) و وردپرس/ووکامرس. بخش فعال و بخش‌های در دسترس نقش شما همین‌جاست.",
      },
    ],
  },
  {
    prefix: "/settings",
    regions: [
      {
        anchor: TOUR_ANCHORS.pageSectionNav,
        title: "منوی تنظیمات",
        body:
          "تنظیمات به بخش‌های جدا تقسیم شده است (کسب‌وکار، تیم، پرداخت، چاپ، اعلان‌ها، اتصال‌ها و…). این منو همان بخش‌ها را جابه‌جا می‌کند و فقط موارد مجاز نقش شما را نشان می‌دهد.",
      },
    ],
  },
];

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
  prefixes: typeof PAGE_TOUR_REGION_PREFIXES = PAGE_TOUR_REGION_PREFIXES,
): PageTourRegion[] {
  const own = regions[pageKey] ?? [];
  const route = pageKey.startsWith("page:") ? pageKey.slice("page:".length) : pageKey;
  const prefixed = prefixes
    .filter((rule) => route === rule.prefix || route.startsWith(`${rule.prefix}/`))
    .flatMap((rule) => rule.regions);
  const seen = new Set<string>();
  const ordered = [...own, ...prefixed, ...(regions["*"] ?? [])].filter((region) => {
    if (seen.has(region.anchor)) return false;
    seen.add(region.anchor);
    return true;
  });
  return ordered;
}

/**
 * The baseline tour for one registered page. Deterministic: same page and same
 * regions, same definition — progress is keyed on the ids it produces.
 */
export function baselineTourForPage(
  page: KnowledgePage,
  regions: Readonly<Record<string, readonly PageTourRegion[]>> = PAGE_TOUR_REGIONS,
  prefixes: typeof PAGE_TOUR_REGION_PREFIXES = PAGE_TOUR_REGION_PREFIXES,
): TourDefinition {
  const declared = regionsForPage(page.key, regions, prefixes);
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

/** Studio-owned routes in the historical coverage audit. */
export const STUDIO_ONLY_PAGE_KEYS: ReadonlySet<string> = new Set([
  "page:/crm/overview",
  "page:/crm/directory",
  "page:/crm/deals",
  "page:/crm/briefs",
  "page:/crm/proposals",
  "page:/crm/client-campaigns",
]);
