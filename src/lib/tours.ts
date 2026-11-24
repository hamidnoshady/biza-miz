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
 *    other source file. The super-admin console publishes to this same shape
 *    (`tour-studio.ts`, migration 0288); a published tour replaces a code tour
 *    with the same id and is otherwise added beside it, so a tour can be edited
 *    without a deployment;
 *  - eligibility (`isTourEligible`): the same permission and industry facts
 *    the page's own guard reads, evaluated on the SERVER before a tour is
 *    ever described to a member (a tour's title is itself metadata);
 *  - progress (`applyTourEvent`, `tourProgressView`): what a member has
 *    *seen*, kept apart from the business setup wizard's `setup.progress`.
 *
 * Two rules carry the design:
 *
 *  - **Seen is not learned.** An explanation or a spotlight is "seen" when the
 *    member pressed Next. A step that asks for something REAL (`kind: "action"`)
 *    does not work that way: `step_seen` is refused for it, and it completes
 *    only through the `verified` event, which the server raises after it finds
 *    evidence that the action succeeded (`tour_action_evidence`, migration
 *    0289, written by the domain endpoint that did the write). No client can
 *    claim a business action happened.
 *  - **Skipped is not seen.** A tour is completed only when every step has
 *    been seen; skipping leaves it in progress and the unseen steps still
 *    count against the denominator.
 *
 * Client-safe: imports types only, plus the industry list.
 */
import { INDUSTRIES, hasSellableCatalogue, isRetailCatalogueIndustry, type Industry } from "./industries";
import { hasCapability, hasModule, industryProfile } from "./industry-profile";
import { KNOWLEDGE_PAGES } from "./knowledge-base";
import { PRODUCT_WORKSPACE_INDUSTRIES } from "./product-workspace";
import { PERMISSIONS, type Permission } from "./permissions";
import { isTourVerifier, type TourVerifier } from "./tour-verifiers";

/**
 * Every `data-tour-id` an owning component exposes. A tour step names an
 * anchor from this list, never a CSS class, a label or a DOM position, so a
 * restyle or a translation cannot silently detach a tour. `tours.test.ts`
 * fails when a registered anchor is not present in the source, or a source
 * anchor is not registered.
 */
export const TOUR_ANCHORS = {
  // The shared page header (`page-chrome.tsx`). Universal on purpose: it is
  // what the automatic baseline tour of every registered page points at
  // (`tour-baseline.ts`), so a page needs no anchor of its own to get one.
  pageHeader: "page.header",
  /** The shared table frame (`data-table.tsx`), for a page whose work is a list. */
  pageTable: "page.table",
  /** The shared filter/search row (`filters.tsx`). */
  pageFilters: "page.filters",
  /** The in-page section menu (`section-nav.tsx`) — settings, inventory, reports. */
  pageSectionNav: "page.section-nav",
  /** The flat app sidebar (`app-section-nav.tsx`) — CRM, Growth, Websites. */
  appSectionNav: "app.section-nav",
  /** Accounting's own workspace sidebar (`accounting-app-nav.tsx`). */
  accountingSectionNav: "accounting.section-nav",
  productsKpis: "products.kpis",
  productsToolbar: "products.toolbar",
  productsExport: "products.export",
  productsTable: "products.table",
  // Accounting home (ledger dashboard and the staff overview).
  overviewFilters: "overview.filters",
  overviewShiftSales: "overview.shift-sales",
  overviewKpis: "overview.kpis",
  overviewShortcuts: "overview.shortcuts",
  overviewRecent: "overview.recent",
  overviewStaffShortcuts: "overview.staff-shortcuts",
  // The till: the café order screen, then the invoice screen retail and
  // service trades sell from.
  posSearch: "pos.search",
  posCategories: "pos.categories",
  posProducts: "pos.products",
  posCart: "pos.cart",
  posCheckoutPay: "pos.checkout-pay",
  posCheckoutOpen: "pos.checkout-open",
  posInvoiceHistoryFilters: "pos.invoice-history-filters",
  posInvoiceHistoryDates: "pos.invoice-history-dates",
  posInvoiceHistoryRows: "pos.invoice-history-rows",
  posInvoiceHistoryTools: "pos.invoice-history-tools",
  posInvoiceHistoryDetails: "pos.invoice-history-details",
  posInvoiceMode: "pos.invoice-mode",
  posInvoiceItems: "pos.invoice-items",
  posInvoiceBarcode: "pos.invoice-barcode",
  posInvoiceLines: "pos.invoice-lines",
  posInvoiceCustomer: "pos.invoice-customer",
  posInvoicePayment: "pos.invoice-payment",
  posInvoiceSubmit: "pos.invoice-submit",
  // The shared party directory's «افزودن مشتری» (dashboard/parties), the same
  // button in the CRM directory, the store's suppliers and the ledger's file.
  partiesAdd: "parties.add",
  // The one inventory workspace (rail + panel) of either stock model.
  inventoryWorkspace: "inventory.workspace",
  // Products workspace.
  productNewIdentity: "product-new.identity",
  productNewTabs: "product-new.tabs",
  productNewDrafts: "product-new.drafts",
  productNewSave: "product-new.save",
  pricesToolbar: "prices.toolbar",
  pricesMatrix: "prices.matrix",
  attributesFilters: "attributes.filters",
  attributesCards: "attributes.cards",
  attributesAdd: "attributes.add",
  productReportsRows: "product-reports.rows",
  barcodePreview: "barcode-templates.preview",
  barcodeTemplates: "barcode-templates.list",
  barcodeAdd: "barcode-templates.add",
  barcodeSave: "barcode-templates.save",
} as const;

export type TourAnchor = (typeof TOUR_ANCHORS)[keyof typeof TOUR_ANCHORS];

/** The attribute a component puts on the element a tour may point at. */
export const TOUR_ANCHOR_ATTRIBUTE = "data-tour-id";

export type TourStepKind =
  /** Centered card — no element involved. */
  | "explain"
  /** Dimmed page with a cut-out around `anchor`. */
  | "spotlight"
  /**
   * The member must DO something on the page. The overlay steps out of the
   * way (no click blocker), the page stays usable, and the step completes only
   * when the server confirms the action through `verifier`.
   */
  | "action"
  /**
   * A guided hand-off to another registered page (issue #972, cross-page
   * tours). The card explains why the member is leaving this screen and offers
   * one button that navigates; nothing moves until they press it. The step
   * itself is an explanation, so pressing it is "seen" once the progress write
   * has been accepted. Steps after it belong to `navigateTo`.
   */
  | "navigate";

export interface TourStep {
  /** Stable across revisions: progress is keyed on it. Never reuse an id for a different step. */
  id: string;
  kind: TourStepKind;
  /** Required for `spotlight`; optional for `action` (the button to press). */
  anchor?: TourAnchor;
  title: string;
  body: string;
  /**
   * Required for `action`, forbidden otherwise: the whitelisted success event
   * the server must find evidence for (`TOUR_VERIFIERS`). It is a key, never a
   * URL or a selector, so a step cannot be verified by an arbitrary request.
   */
  verifier?: TourVerifier;
  /**
   * Required for `navigate`, forbidden otherwise: the canonical registered
   * route this step hands the member to. The runtime never navigates on its
   * own — the member presses the step's one button — and every step after it
   * belongs to that route until the next navigate step.
   */
  navigateTo?: string;
  /**
   * Narrows the tour for the viewer: a step the viewer does not match is not
   * part of THEIR tour at all (not described, not counted, not required for
   * completion), so a read-only member is never walked through a save button
   * they cannot press. Omitted = every viewer the tour is offered to.
   */
  eligibility?: TourEligibility;
}

/** The business's costing system, as the inventory workspace distinguishes it. */
export type TourInventorySystem = "perpetual" | "periodic";

export interface TourEligibility {
  /** All of these must be held. */
  permissions?: readonly Permission[];
  /** None of these may be held — a screen that exists only for members without a door. */
  withoutPermissions?: readonly Permission[];
  /** The business's industry must be one of these. Omitted = every trade. */
  industries?: readonly Industry[];
  /**
   * Feature flags that must be on. A flag the catalogue does not list counts
   * as on, the way the pages themselves read it (`features.ledger ?? true`).
   */
  features?: readonly string[];
  /** Feature flags that must be explicitly off. */
  withoutFeatures?: readonly string[];
  /** The business's inventory system (food-service stock only). */
  inventorySystem?: TourInventorySystem;
  /** At least one of these alternatives must also match. */
  anyOf?: readonly TourEligibility[];
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

// Which trades a screen is built for is read from the same profile the page
// reads, never restated: a trade added later lands in the right group by what
// it IS, and `tours.test.ts` fails if any trade ends up with no till or no
// inventory tour.
const industriesWhere = (test: (industry: Industry) => boolean): readonly Industry[] =>
  INDUSTRIES.filter(test);

/** The café order screen (`PosScreen`). */
const ORDER_TICKET_INDUSTRIES = industriesWhere(
  (industry) => industryProfile(industry).salesModel === "order_ticket",
);
/** The invoice screen over a priced catalogue (`RetailInvoiceScreen`). */
const CATALOGUE_INVOICE_INDUSTRIES = industriesWhere(
  (industry) =>
    industryProfile(industry).salesModel === "retail_invoice" && hasSellableCatalogue(industry),
);
/** The same screen over described service lines. */
const SERVICE_INVOICE_TRADES = industriesWhere(
  (industry) =>
    industryProfile(industry).salesModel === "retail_invoice" && !hasSellableCatalogue(industry),
);
/** Trades whose invoice screen carries the barcode scan field. */
const BARCODE_INDUSTRIES = industriesWhere((industry) => hasCapability(industry, "barcode"));
/** `inventory_items` stock (the food-service workspace). */
const FOOD_STOCK_INDUSTRIES = industriesWhere((industry) => hasModule(industry, "inventory"));
/** `items`/`item_stock` stock (the retail workspace). */
const RETAIL_STOCK_INDUSTRIES = industriesWhere(
  (industry) => hasModule(industry, "stock") && !hasModule(industry, "inventory"),
);

/** The same door `AccountingPageBody` checks before it draws the ledger dashboard. */
const LEDGER_DOOR = PERMISSIONS.ledgerView;
const POS_PERMISSIONS = [PERMISSIONS.ordersCreate, PERMISSIONS.paymentsTake] as const;

/**
 * The closing steps of the invoice screen, shared by the catalogue and the
 * service tours: both end in the same aside card (lines, customer, payment
 * way, the hold-to-confirm button) and the same invoice list.
 */
const INVOICE_TAIL_STEPS: readonly TourStep[] = [
  {
    id: "lines",
    kind: "spotlight",
    anchor: TOUR_ANCHORS.posInvoiceLines,
    title: "فاکتور جاری",
    body:
      "ردیف‌های اضافه‌شده، مالیات هر ردیف و جمع جزء، مالیات و جمع کل اینجاست. با «حذف» کنار هر ردیف، آن ردیف را از فاکتور برمی‌دارید.",
  },
  {
    id: "customer",
    kind: "spotlight",
    anchor: TOUR_ANCHORS.posInvoiceCustomer,
    title: "مشتری",
    body: "مشتری را از فهرست اشخاص انتخاب کنید. برای فروش نسیه، انتخاب مشتری الزامی است.",
  },
  {
    id: "payment",
    kind: "spotlight",
    anchor: TOUR_ANCHORS.posInvoicePayment,
    title: "روش پرداخت",
    body:
      "یکی از روش‌های دریافت وجهِ فعال کسب‌وکار را انتخاب کنید، یا با «تقسیم بین چند روش» مبلغ فاکتور را بین چند روش پخش کنید؛ فقط یک ردیف می‌تواند بدون مبلغ بماند و باقی‌مانده را می‌گیرد. بعضی روش‌ها شمارهٔ پیگیری می‌خواهند.",
  },
  {
    id: "submit",
    kind: "spotlight",
    anchor: TOUR_ANCHORS.posInvoiceSubmit,
    title: "ثبت فاکتور",
    body:
      "برای ثبت، دکمه را ۲ ثانیه نگه دارید؛ این نگه‌داشتن جلوی ثبت ناخواسته را می‌گیرد. پس از ثبت می‌توانید رسید را چاپ کنید. تور هرگز این دکمه را نمی‌زند.",
  },
  {
    id: "manage",
    kind: "explain",
    title: "مدیریت فاکتورها",
    body:
      "برای بازبینی یا چاپ مجدد، به زبانهٔ «مدیریت فاکتورها» بروید: فاکتورهای ثبت‌شدهٔ این شعبه را جست‌وجو و بر اساس روش پرداخت فیلتر می‌کنید و جزئیات و چاپ هر فاکتور را باز می‌کنید.",
  },
  {
    id: "void",
    kind: "explain",
    title: "ابطال فاکتور",
    body:
      "نقش شما اجازهٔ اصلاح فاکتور ثبت‌شده را دارد: در جزئیات فاکتور «ابطال فاکتور» با ثبت دلیل، فاکتور و ثبت‌های حسابداری آن را کامل برمی‌گرداند. تور آن را انجام نمی‌دهد.",
    eligibility: { permissions: [PERMISSIONS.ordersAmendClosed] },
  },
];

interface ListPageTourSpec {
  id: string;
  pageKey: string;
  title: string;
  description: string;
  introTitle: string;
  introBody: string;
  nextBody: string;
  eligibility: TourEligibility;
  navAnchor: TourAnchor;
  filters?: boolean;
  table?: boolean;
}

/**
 * A list/ledger page's walkthrough, built from the shared regions its shell
 * already renders: the page header, the app menu, and (when the page really has
 * them) the filter row and table frame. Each entry still supplies its own
 * purpose and next step, so the copy is about that screen rather than a generic
 * template; a missing region degrades to its explanation after three seconds.
 */
function listPageTour(spec: ListPageTourSpec): TourDefinition {
  const steps: TourStep[] = [
    { id: "welcome", kind: "explain", title: spec.introTitle, body: spec.introBody },
    {
      id: "header",
      kind: "spotlight",
      anchor: TOUR_ANCHORS.pageHeader,
      title: "این صفحه و کارهای آن",
      body:
        "عنوان، توضیح کوتاه و کنترل‌های اصلی همین‌جاست. دکمهٔ آموزش و راهنمای مکتوب این صفحه هم در همین نوار است.",
    },
    {
      id: "menu",
      kind: "spotlight",
      anchor: spec.navAnchor,
      title: "جابه‌جایی بین بخش‌ها",
      body:
        "از این منو بین بخش‌های همین برنامه می‌روید. بخش فعال و بخش‌هایی که نقش شما اجازهٔ دیدنشان را دارد در همین فهرست است.",
    },
  ];
  if (spec.filters) {
    steps.push({
      id: "filters",
      kind: "spotlight",
      anchor: TOUR_ANCHORS.pageFilters,
      title: "جست‌وجو و محدودکردن فهرست",
      body:
        "با جست‌وجو یا فیلتر، فهرست را به آنچه می‌خواهید محدود کنید. نتیجه همان چیزی است که دسترسی شما نشان می‌دهد.",
    });
  }
  if (spec.table) {
    steps.push({
      id: "table",
      kind: "spotlight",
      anchor: TOUR_ANCHORS.pageTable,
      title: "ردیف‌ها و ستون‌ها",
      body:
        "هر ردیف یک مورد است و ستون‌ها وضعیت، مبلغ یا تاریخ آن را نشان می‌دهند. برای دیدن جزئیات، ردیف را باز کنید؛ تور چیزی را تغییر نمی‌دهد.",
    });
  }
  steps.push({ id: "next", kind: "explain", title: "قدم بعدی", body: spec.nextBody });
  return {
    id: spec.id,
    version: 1,
    pageKey: spec.pageKey,
    route: spec.pageKey.replace(/^page:/, ""),
    title: spec.title,
    description: spec.description,
    eligibility: spec.eligibility,
    steps,
  };
}

/**
 * A page of one of the two website managers. Their shells draw one shared menu
 * and one page header, and their bodies are cards rather than tables, so every
 * page tour is: what the screen is for, the header, the manager menu, the one or
 * two decisions the screen really makes, and a truthful next step. Declared
 * region anchors only — the page bodies expose no `data-tour-id` of their own,
 * so this helper never invents a control.
 */
interface WebsitePageTourSpec {
  id: string;
  pageKey: string;
  title: string;
  description: string;
  eligibility: TourEligibility;
  intro: { title: string; body: string };
  details: readonly { title: string; body: string }[];
  nextBody: string;
}

function websitePageTour(spec: WebsitePageTourSpec): TourDefinition {
  const steps: TourStep[] = [
    { id: "welcome", kind: "explain", ...spec.intro },
    {
      id: "header",
      kind: "spotlight",
      anchor: TOUR_ANCHORS.pageHeader,
      title: "سرصفحهٔ صفحه",
      body:
        "عنوان صفحه، توضیح کوتاه آن و کارهای اصلی بالای آن چیده شده‌اند؛ دکمهٔ «آموزش» هم در همین نوار است.",
    },
    {
      id: "menu",
      kind: "spotlight",
      anchor: TOUR_ANCHORS.appSectionNav,
      title: "منوی مدیریت وب‌سایت",
      body:
        "این منو دو مدیر سایت را کنار هم نگه می‌دارد: سایت بیزامیز (CMS) و وردپرس/ووکامرس. بخش فعال و بخش‌های در دسترس نقش شما همین‌جاست.",
    },
    ...spec.details.map((detail, index) => ({
      id: `detail-${index + 1}`,
      kind: "explain" as const,
      title: detail.title,
      body: detail.body,
    })),
    { id: "next", kind: "explain", title: "قدم بعدی", body: spec.nextBody },
  ];
  return {
    id: spec.id,
    version: 1,
    pageKey: spec.pageKey,
    route: spec.pageKey.replace(/^page:/, ""),
    title: spec.title,
    description: spec.description,
    eligibility: spec.eligibility,
    steps,
  };
}

/** The same shape for an Accounting work area; the menu is the app's own rail. */
function accountingPageTour(spec: WebsitePageTourSpec): TourDefinition {
  const steps: TourStep[] = [
    { id: "welcome", kind: "explain", ...spec.intro },
    {
      id: "header",
      kind: "spotlight",
      anchor: TOUR_ANCHORS.pageHeader,
      title: "سرصفحهٔ صفحه",
      body:
        "عنوان، توضیح و کارهای اصلی این بخش بالای صفحه‌اند؛ دکمهٔ «آموزش» هم در همین نوار است.",
    },
    {
      id: "menu",
      kind: "spotlight",
      anchor: TOUR_ANCHORS.accountingSectionNav,
      title: "منوی فضای کار حسابداری",
      body:
        "از این منو بین بخش‌های حسابداری جابه‌جا می‌شوید. فقط بخش‌هایی که برای نقش شما مجاز است در این فهرست دیده می‌شود.",
    },
    ...spec.details.map((detail, index) => ({
      id: `detail-${index + 1}`,
      kind: "explain" as const,
      title: detail.title,
      body: detail.body,
    })),
    { id: "next", kind: "explain", title: "قدم بعدی", body: spec.nextBody },
  ];
  return {
    id: spec.id,
    version: 1,
    pageKey: spec.pageKey,
    route: spec.pageKey.replace(/^page:/, ""),
    title: spec.title,
    description: spec.description,
    eligibility: spec.eligibility,
    steps,
  };
}

export const TOURS: readonly TourDefinition[] = [  {
    id: "crm.directory.first-customer",
    version: 1,
    pageKey: "page:/crm/directory",
    route: "/crm/directory",
    title: "اولین مشتری را ثبت کنید",
    description:
      "این تور با شما کار می‌کند: صفحه قفل نمی‌شود، مشتری را خودتان ثبت می‌کنید و مرحلهٔ آخر وقتی کامل می‌شود که سرور همان ثبت را تأیید کند.",
    eligibility: { permissions: [PERMISSIONS.partiesManage] },
    steps: [
      {
        id: "how-it-works",
        kind: "explain",
        title: "این بار خودتان انجام می‌دهید",
        body:
          "در این تور صفحه قفل نمی‌شود و هیچ دکمه‌ای هم به‌جای شما زده نمی‌شود: «افزودن مشتری» را خودتان می‌زنید و فرم را پر می‌کنید. مرحلهٔ آخر با فشردن دکمهٔ «بعدی» کامل نمی‌شود؛ وقتی سرور ثبت مشتری را تأیید کند، خودکار تأیید می‌شود.",
      },
      {
        id: "what-is-a-party",
        kind: "explain",
        title: "این فهرست مشترک است",
        body:
          "این فهرست همان فهرست «اشخاص» است که تأمین‌کنندگان، کارکنان و پروندهٔ طرف حساب در حسابداری هم از آن می‌خوانند. یک مشتری را یک بار ثبت می‌کنید و همه‌جا همان پرونده دیده می‌شود؛ به همین دلیل هم فقط کسی با دسترسی «مدیریت اشخاص» می‌تواند چیزی اضافه کند.",
      },
      {
        id: "register",
        kind: "action",
        anchor: TOUR_ANCHORS.partiesAdd,
        verifier: "party.created",
        title: "مشتری را ثبت کنید",
        body:
          "دکمهٔ «افزودن مشتری» را بزنید، نام را بنویسید (شمارهٔ تماس و بقیهٔ فیلدها اختیاری‌اند) و فرم را ذخیره کنید. اگر همین حالا این کار را کرده بودید، نیازی به تکرار نیست: «بررسی» را بزنید تا همان ثبت قبلی تأیید شود.",
      },
    ],
  },
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
  // -------------------------------------------------------------------------
  // The rest of the pages that have a published Knowledge Base article.
  //
  // Where one route renders different screens (the ledger dashboard vs the
  // staff overview; the café till vs the invoice screen; the two stock models
  // and the two costing systems) there is one tour per screen, and their
  // eligibility rules are disjoint — `tours.test.ts` proves a viewer is never
  // offered two, or the wrong one. A tour describes only controls its screen
  // really draws for that viewer: a step the viewer's permissions do not
  // reach is filtered out of THEIR tour (`TourStep.eligibility`).
  // -------------------------------------------------------------------------
  {
    id: "accounting.overview.ledger",
    version: 1,
    pageKey: "page:/accounting/overview",
    route: "/accounting/overview",
    title: "آشنایی با میز کار حسابداری",
    description: "با فیلتر تاریخ، فروش شیفت، نشانگرهای مالی و میان‌برهای صفحهٔ اول حسابداری آشنا شوید.",
    eligibility: { permissions: [LEDGER_DOOR], features: ["ledger"] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "میز کار حسابداری",
        body:
          "این صفحهٔ اول حسابداری است: وضعیت پول و دفتر در یک نگاه. در چند مرحله بخش‌های آن را می‌بینیم؛ این تور چیزی را تغییر نمی‌دهد.",
      },
      {
        id: "filters",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.overviewFilters,
        title: "تاریخ مبنا و دورهٔ مالی",
        body:
          "مانده‌ها در «تاریخ مبنا» خوانده می‌شوند و درآمد و هزینه برای «دورهٔ مالی» انتخاب‌شده. اگر چیزی انتخاب نکنید، امروزِ کسب‌وکار و سال مالیِ همان تاریخ به‌کار می‌رود.",
      },
      {
        id: "shift-sales",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.overviewShiftSales,
        title: "فروش شیفت یا روز کاری",
        body:
          "جمع فروش همهٔ کانال‌های این شعبه از آخرین بستن شیفت، به تفکیک نقدی، کارت، آنلاین و نسیه. اگر شعبه شیفت ثبت نکند، بازه همان روز کاری است.",
      },
      {
        id: "notices",
        kind: "explain",
        title: "هشدارهای دفتر",
        body:
          "هر وقت دفتر به توجه نیاز داشته باشد، بالای نشانگرها پیامی می‌آید؛ مثل نبودن سال مالی یا ناقص بودن بهای تمام‌شدهٔ بعضی فروش‌ها که سود را «موقت» می‌کند. این پیام‌ها فقط در صورت نیاز ظاهر می‌شوند و راه رفع هر کدام کنار خودش آمده است.",
      },
      {
        id: "kpis",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.overviewKpis,
        title: "نشانگرهای مالی",
        body:
          "نقدینگی قابل استفاده، وجوه در راه (تسویه‌نشده)، دریافتنی‌ها و پرداختنی‌ها، و سپس درآمد، هزینه و سود خالص دورهٔ انتخاب‌شده. اگر به تراز آزمایشی دسترسی دارید، هر کارت ریز همان عدد را باز می‌کند.",
      },
      {
        id: "shortcuts",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.overviewShortcuts,
        title: "کارهای رایج",
        body:
          "میان‌برهای کارهای پرتکرار مثل اشخاص، حساب‌های دریافتنی و پرداختنی، ثبت سند دستی، چک‌ها، تطبیق بانکی و گزارش‌های مالی. فقط بخش‌هایی نشان داده می‌شود که نقش شما به آن‌ها دسترسی دارد.",
      },
      {
        id: "recent",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.overviewRecent,
        title: "اسناد اخیر",
        body:
          "پنج سند آخر دفتر با شرح، منبع، تاریخ و مبلغ. با فلش کنار هر سند، آن را در دفتر روزنامه باز می‌کنید.",
      },
    ],
  },
  {
    id: "accounting.overview.staff",
    version: 1,
    pageKey: "page:/accounting/overview",
    route: "/accounting/overview",
    title: "آشنایی با میز کار شما",
    description: "ببینید میان‌برهای حسابداری برای نقش شما چگونه چیده شده است.",
    // The staff overview is what the page draws for a member without the
    // ledger door, and also when the business has the ledger switched off.
    eligibility: { anyOf: [{ withoutPermissions: [LEDGER_DOOR] }, { withoutFeatures: ["ledger"] }] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "میز کار شما",
        body:
          "این صفحه میان‌برهای بخش‌هایی را نشان می‌دهد که نقش شما به آن‌ها دسترسی دارد. در این نما رقم مالی نمی‌آید؛ این تور چیزی را تغییر نمی‌دهد.",
      },
      {
        id: "shortcuts",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.overviewStaffShortcuts,
        title: "میان‌برها",
        body:
          "هر کارت شما را مستقیم به یکی از بخش‌های در دسترستان می‌برد؛ همان بخش‌هایی که در منوی کناری هم می‌بینید.",
      },
      {
        id: "figures",
        kind: "explain",
        title: "ارقام دفتر",
        body: "ارقام و مانده‌های دفتر در این نما نشان داده نمی‌شود؛ اگر به آن‌ها نیاز دارید، با مدیر کسب‌وکار صحبت کنید.",
      },
    ],
  },
  {
    id: "accounting.pos.order-ticket",
    version: 1,
    pageKey: "page:/accounting/pos",
    route: "/accounting/pos",
    title: "آشنایی با صندوق فروش",
    description: "جست‌وجوی محصول، سبد، نوع سفارش و دریافت وجه را ببینید، بدون ثبت سفارش واقعی.",
    eligibility: { permissions: POS_PERMISSIONS, industries: ORDER_TICKET_INDUSTRIES },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "صندوق فروش",
        body:
          "از اینجا سفارش را می‌سازید، باز نگه می‌دارید یا وجه آن را می‌گیرید. این تور هیچ سفارش یا پرداختی ثبت نمی‌کند و روی صفحه کلیک نمی‌زند.",
      },
      {
        id: "search",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.posSearch,
        title: "جست‌وجوی محصول",
        body:
          "نام یا کد کالا را بنویسید. کلید / مستقیم شما را به این کادر می‌برد، با فلش‌ها نتیجه را انتخاب می‌کنید و Enter آن را به سبد اضافه می‌کند.",
      },
      {
        id: "categories",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.posCategories,
        title: "دسته‌بندی",
        body:
          "با انتخاب هر دسته فقط محصولات همان دسته را می‌بینید. در رایانه می‌توانید با Alt و عدد ۱ تا ۹ دسته‌ها را عوض کنید.",
      },
      {
        id: "products",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.posProducts,
        title: "کارت محصولات",
        body:
          "لمس کارت یک واحد به سبد اضافه می‌کند. «تنظیم» افزودنی‌ها، یادداشت و تعداد را باز می‌کند، و بعد از افزودن، نوار − / + همان‌جا تعداد را اصلاح می‌کند.",
      },
      {
        id: "cart",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.posCart,
        title: "سبد و نوع سفارش",
        body:
          "نوع سفارش (حضوری، بیرون‌بر یا ارسالی؛ بسته به امکاناتی که برای کسب‌وکار فعال است)، میز و تعداد مهمان برای سفارش حضوری، آدرس و پیک برای ارسالی، مشتری و ردیف‌های سفارش اینجاست. روی تلفن همراه این نوار پایین صفحه است و با لمس آن سبد باز می‌شود.",
      },
      {
        id: "discount",
        kind: "explain",
        title: "تخفیف",
        body:
          "نقش شما اجازهٔ تخفیف دارد: بالای دکمه‌های پرداخت می‌توانید تخفیف درصدی یا مبلغ ثابت بگذارید و جمع کل بلافاصله به‌روز می‌شود.",
        eligibility: { permissions: [PERMISSIONS.ordersDiscount] },
      },
      {
        id: "checkout",
        kind: "explain",
        title: "دریافت وجه یا سفارش باز",
        body:
          "«دریافت وجه و تکمیل» سفارش را وارد مرحلهٔ پرداخت می‌کند که روش دریافت و انعام آنجا انتخاب می‌شود. «ثبت سفارش باز» سفارش را بدون دریافت وجه ثبت می‌کند. اگر میز یا آدرس لازم باشد، دکمه همان را از شما می‌خواهد. تور هیچ‌کدام را نمی‌زند.",
      },
      {
        id: "order-created",
        kind: "action",
        anchor: TOUR_ANCHORS.posInvoiceSubmit,
        verifier: "order.created",
        title: "سفارش را ثبت کنید",
        body:
          "دکمهٔ «دریافت وجه و تکمیل» یا «ثبت سفارش باز» را بزنید. وقتی سرور سفارش را تأیید کند، این مرحله خودکار کامل می‌شود. تور هرگز دکمهٔ ثبت را نمی‌زند.",
      },
    ],
  },
  {
    id: "accounting.pos.invoice",
    version: 1,
    pageKey: "page:/accounting/pos",
    route: "/accounting/pos",
    title: "آشنایی با صدور فاکتور",
    description: "افزودن کالا، مشتری، روش پرداخت و ثبت فاکتور را ببینید، بدون ثبت فاکتور واقعی.",
    eligibility: { permissions: POS_PERMISSIONS, industries: CATALOGUE_INVOICE_INDUSTRIES },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "فروش و فاکتور",
        body:
          "کالاها را به فاکتور اضافه می‌کنید، مشتری و روش پرداخت را مشخص می‌کنید و فاکتور را ثبت می‌کنید. این تور هیچ فاکتوری ثبت نمی‌کند.",
      },
      {
        id: "mode",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.posInvoiceMode,
        title: "صدور یا مدیریت فاکتورها",
        body:
          "«صدور فاکتور» برای فروش تازه است. «مدیریت فاکتورها» فهرست فاکتورهای ثبت‌شدهٔ این شعبه را با جست‌وجو، فیلتر روش پرداخت، جزئیات و چاپ مجدد نشان می‌دهد.",
      },
      {
        id: "items",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.posInvoiceItems,
        title: "افزودن کالا",
        body:
          "کالا را با فرم مخصوص صنف خود به فاکتور اضافه کنید؛ قیمت و مالیات هر ردیف در «فاکتور جاری» نشان داده می‌شود.",
      },
      {
        id: "barcode",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.posInvoiceBarcode,
        title: "اسکن بارکد",
        body:
          "بارکد کالا را اسکن یا تایپ کنید تا به فاکتور اضافه شود. اگر کد پیدا نشود یا به بیش از یک کالا اشاره کند، پیام می‌گیرید و کالا را دستی انتخاب می‌کنید.",
        eligibility: { industries: BARCODE_INDUSTRIES },
      },
      ...INVOICE_TAIL_STEPS,
      {
        id: "order-created",
        kind: "action",
        anchor: TOUR_ANCHORS.posInvoiceSubmit,
        verifier: "order.created",
        title: "فاکتور را ثبت کنید",
        body:
          "دکمهٔ «ثبت فاکتور» را ۲ ثانیه نگه دارید و فاکتور را ثبت کنید. وقتی سرور ثبت فاکتور را تأیید کند، این مرحله خودکار کامل می‌شود. تور هرگز دکمهٔ ثبت را نمی‌زند.",
      },
    ],
  },
  {
    id: "accounting.pos.service-invoice",
    version: 1,
    pageKey: "page:/accounting/pos",
    route: "/accounting/pos",
    title: "آشنایی با صدور صورتحساب خدمات",
    description: "ثبت خدمت، مشتری، روش پرداخت و ثبت فاکتور را ببینید، بدون ثبت فاکتور واقعی.",
    eligibility: { permissions: POS_PERMISSIONS, industries: SERVICE_INVOICE_TRADES },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "صدور صورتحساب",
        body:
          "خدمت‌ها را با شرح، تعداد و قیمت به صورتحساب اضافه می‌کنید، مشتری و روش پرداخت را مشخص می‌کنید و ثبتش می‌کنید. این تور چیزی ثبت نمی‌کند.",
      },
      {
        id: "mode",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.posInvoiceMode,
        title: "صدور یا مدیریت فاکتورها",
        body:
          "«صدور فاکتور» برای صورتحساب تازه است. «مدیریت فاکتورها» فهرست ثبت‌شده‌ها را با جست‌وجو، فیلتر روش پرداخت، جزئیات و چاپ مجدد نشان می‌دهد.",
      },
      {
        id: "items",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.posInvoiceItems,
        title: "ثبت خدمت",
        body:
          "شرح کار، تعداد، قیمت واحد، تخفیف، درصد مالیات و حساب درآمد را وارد کنید؛ پیش‌نمایش قیمت با همان محاسبه‌ای نشان داده می‌شود که هنگام ثبت به‌کار می‌رود. خدمت موجودی کالا ندارد.",
      },
      ...INVOICE_TAIL_STEPS,
      {
        id: "order-created",
        kind: "action",
        anchor: TOUR_ANCHORS.posInvoiceSubmit,
        verifier: "order.created",
        title: "صورتحساب را ثبت کنید",
        body:
          "دکمهٔ «ثبت فاکتور» را ۲ ثانیه نگه دارید و صورتحساب را ثبت کنید. وقتی سرور ثبت را تأیید کند، این مرحله خودکار کامل می‌شود. تور هرگز دکمهٔ ثبت را نمی‌زند.",
      },
    ],
  },
  {
    id: "accounting.inventory.food-service",
    version: 1,
    pageKey: "page:/accounting/inventory",
    route: "/accounting/inventory",
    title: "آشنایی با انبار",
    description: "با انبارها، موجودی، سند ورود و خروج، دستور مصرف، تولید، خرید و ضایعات آشنا شوید.",
    eligibility: {
      permissions: [PERMISSIONS.inventoryView],
      industries: FOOD_STOCK_INDUSTRIES,
      features: ["inventory"],
      inventorySystem: "perpetual",
    },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "انبار",
        body:
          "انبار مواد اولیه و اقلام کافه یا رستوران: انبارها، موجودی، سند ورود و خروج، دستور مصرف، تولید، خرید و ضایعات. این تور هیچ موجودی یا سندی را تغییر نمی‌دهد.",
      },
      {
        id: "sections",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.inventoryWorkspace,
        title: "بخش‌های انبار",
        body:
          "بخش‌ها در سه گروه آمده‌اند: «انبارها» (لیست انبارها، موجودی انبار، انبارگردانی)، «سند انبار» (ثبت رسید یا حواله و فهرست آن‌ها) و «اقلام و عملیات» (اقلام، تولید، دستور مصرف، تأمین‌کنندگان، خرید، ضایعات، انتقال بین انبارها، بارکد و لیبل). روی تلفن همراه ابتدا همین فهرست را می‌بینید و با انتخاب هر بخش وارد آن می‌شوید.",
      },
      {
        id: "stock",
        kind: "explain",
        title: "موجودی و انبارگردانی",
        body:
          "«موجودی انبار» مقدار و بهای هر قلم را نشان می‌دهد؛ با باز کردن یک انبار از «لیست انبارها» همان انبار را می‌بینید. در سیستم دائمی هر ورود و خروج با بهای خودش ثبت می‌شود و «انبارگردانی» شمارش واقعی را با موجودی دفتر مقایسه می‌کند.",
      },
      {
        id: "documents",
        kind: "explain",
        title: "رسید و حوالهٔ انبار",
        body:
          "«ثبت رسید انبار/حواله» برای ورود یا خروج دستی کالاست و سند ثبت‌شده در «رسید و حواله‌های انبار» می‌ماند. ثبت سند به دسترسی تعدیل موجودی نیاز دارد که نقش شما دارد.",
        eligibility: { permissions: [PERMISSIONS.inventoryAdjust] },
      },
      {
        id: "items-recipes",
        kind: "explain",
        title: "اقلام، دستور مصرف و تولید",
        body:
          "«اقلام انبار» فهرست مواد اولیه و کالاهاست. «دستور مصرف» هر آیتم منو را به مواد مصرفی‌اش وصل می‌کند تا با هر فروش موجودی کم شود. «تولید» برای کالایی است که خودتان از مواد اولیه می‌سازید (مثل کیک) و خودِ آن یک قلم عادی انبار می‌شود.",
      },
      {
        id: "purchases",
        kind: "explain",
        title: "تأمین‌کنندگان و خرید",
        body:
          "تأمین‌کنندگان را ثبت کنید و خرید را وارد کنید تا کالا به موجودی اضافه شود. خرید نسیه به انتخاب تأمین‌کننده نیاز دارد.",
      },
      {
        id: "waste-transfers",
        kind: "explain",
        title: "ضایعات و انتقال",
        body:
          "ضایعات را ثبت کنید تا از موجودی کم شود. «انتقال بین انبارها» موجودی را از یک انبار به انبار دیگر می‌برد.",
      },
      {
        id: "barcodes",
        kind: "explain",
        title: "بارکد و لیبل",
        body:
          "برای هر قلم انبار بارکد تعیین کنید و لیبل آن را چاپ کنید تا شمارش و رسیدگی با اسکنر سریع‌تر شود.",
      },
      {
        id: "receive-purchase",
        kind: "action",
        verifier: "stock.received",
        title: "یک خرید را دریافت کنید",
        body:
          "از بخش «تأمین‌کنندگان و خرید» یک خرید با حداقل یک قلم ثبت و دریافت کنید. این مرحله با «بعدی» کامل نمی‌شود؛ وقتی سرور خرید را ثبت و موجودی را به‌روز کند، خودکار تأیید می‌شود. اگر خرید واقعی ندارید، می‌توانید رد شوید.",
        eligibility: { permissions: [PERMISSIONS.purchasesManage] },
      },
      {
        id: "after-purchase",
        kind: "explain",
        title: "پس از دریافت",
        body:
          "خرید در فهرست خریدها و تاریخچهٔ انبار دیده می‌شود. اصلاح یا برگشت خرید از مسیر مجاز خودش انجام می‌شود، نه با تور.",
        eligibility: { permissions: [PERMISSIONS.purchasesManage] },
      },
    ],
  },
  {
    id: "accounting.inventory.food-service-periodic",
    version: 1,
    pageKey: "page:/accounting/inventory",
    route: "/accounting/inventory",
    title: "آشنایی با انبار (سیستم ادواری)",
    description: "با بخش‌های انبار در سیستم ادواری و بستن دوره آشنا شوید.",
    eligibility: {
      permissions: [PERMISSIONS.inventoryView],
      industries: FOOD_STOCK_INDUSTRIES,
      features: ["inventory"],
      inventorySystem: "periodic",
    },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "انبار در سیستم ادواری",
        body:
          "کسب‌وکار شما سیستم ادواری را برای انبار انتخاب کرده است. این تور هیچ موجودی یا سندی را تغییر نمی‌دهد و فقط بخش‌هایی را نشان می‌دهد که در این سیستم دارید.",
      },
      {
        id: "sections",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.inventoryWorkspace,
        title: "بخش‌های انبار",
        body:
          "«انبارها» شامل لیست انبارها، موجودی انبار و بستن دوره (ادواری) است و «اقلام و عملیات» شامل اقلام، دستور مصرف، تأمین‌کنندگان، خرید و بارکد و لیبل. روی تلفن همراه ابتدا همین فهرست را می‌بینید و با انتخاب هر بخش وارد آن می‌شوید.",
      },
      {
        id: "periodic",
        kind: "explain",
        title: "بستن دوره",
        body:
          "در سیستم ادواری هر حرکت بهای خودش را ندارد؛ برای همین انبارگردانی، سند ورود و خروج، تولید، ضایعات و انتقال بین انبارها در این نما نیست و «بستن دوره (ادواری)» که در پایان هر دوره انجام می‌دهید جای آن‌هاست.",
      },
      {
        id: "stock",
        kind: "explain",
        title: "موجودی انبار",
        body:
          "«موجودی انبار» مقدار هر قلم را نشان می‌دهد؛ با باز کردن یک انبار از «لیست انبارها» همان انبار را می‌بینید.",
      },
      {
        id: "items-recipes",
        kind: "explain",
        title: "اقلام و دستور مصرف",
        body:
          "«اقلام انبار» فهرست مواد اولیه و کالاهاست و «دستور مصرف» هر آیتم منو را به مواد مصرفی‌اش وصل می‌کند.",
      },
      {
        id: "purchases",
        kind: "explain",
        title: "تأمین‌کنندگان و خرید",
        body:
          "تأمین‌کنندگان را ثبت کنید و خرید را وارد کنید. خرید نسیه به انتخاب تأمین‌کننده نیاز دارد.",
      },
      {
        id: "barcodes",
        kind: "explain",
        title: "بارکد و لیبل",
        body: "برای هر قلم انبار بارکد تعیین کنید و لیبل آن را چاپ کنید.",
      },
      {
        id: "receive-purchase",
        kind: "action",
        verifier: "stock.received",
        title: "یک خرید را دریافت کنید",
        body:
          "از بخش «تأمین‌کنندگان و خرید» یک خرید با حداقل یک قلم ثبت و دریافت کنید. این مرحله با «بعدی» کامل نمی‌شود؛ وقتی سرور خرید را ثبت کند، خودکار تأیید می‌شود. اگر خرید واقعی ندارید، می‌توانید رد شوید.",
        eligibility: { permissions: [PERMISSIONS.purchasesManage] },
      },
      {
        id: "after-purchase",
        kind: "explain",
        title: "پس از دریافت",
        body:
          "خرید در فهرست خریدها دیده می‌شود. اصلاح یا برگشت خرید از مسیر مجاز خودش انجام می‌شود، نه با تور.",
        eligibility: { permissions: [PERMISSIONS.purchasesManage] },
      },
    ],
  },
  {
    id: "accounting.inventory.retail",
    version: 1,
    pageKey: "page:/accounting/inventory",
    route: "/accounting/inventory",
    title: "آشنایی با خرید و انبار",
    description: "با انبارها، موجودی، سند ورود و خروج، انبارگردانی، خرید و حواله بازگشت آشنا شوید.",
    eligibility: { permissions: [PERMISSIONS.inventoryView], industries: RETAIL_STOCK_INDUSTRIES },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "خرید و انبار",
        body:
          "انبارهای کالا، موجودی، سند ورود و خروج، انبارگردانی، خرید و برگشت به تأمین‌کننده. این تور هیچ موجودی یا سندی را تغییر نمی‌دهد.",
      },
      {
        id: "sections",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.inventoryWorkspace,
        title: "بخش‌های انبار",
        body:
          "«انبارها» (افزودن انبار، لیست انبارها)، «سند انبار» (ثبت رسید یا حواله و فهرست آن‌ها) و «اقلام و عملیات» (موجودی انبار، انبارگردانی، خرید، حواله بازگشت و گزارش). روی تلفن همراه ابتدا همین فهرست را می‌بینید و با انتخاب هر بخش وارد آن می‌شوید.",
      },
      {
        id: "stock",
        kind: "explain",
        title: "موجودی انبار",
        body:
          "مقدار و بهای واحد هر کالا را در هر انبار ببینید؛ با باز کردن یک انبار از «لیست انبارها» مستقیم به موجودی همان انبار می‌روید.",
      },
      {
        id: "documents",
        kind: "explain",
        title: "رسید و حوالهٔ انبار",
        body:
          "«ثبت رسید انبار/حواله» برای ورود یا خروج دستی کالاست و سند ثبت‌شده در «رسید و حواله‌های انبار» دیده می‌شود.",
      },
      {
        id: "counts",
        kind: "explain",
        title: "انبارگردانی",
        body:
          "تعداد شمارش‌شدهٔ هر کالا جایگزین موجودی می‌شود و بهای واحد کالا تغییر نمی‌کند. کمبود و مازاد جدا از هم ثبت می‌شوند و هیچ‌کدام دیگری را خنثی نمی‌کند.",
      },
      {
        id: "purchases-returns",
        kind: "explain",
        title: "خرید و حوالهٔ بازگشت",
        body:
          "خرید از تأمین‌کننده را در «خرید» ثبت کنید. «حواله بازگشت» کالایی را که به تأمین‌کننده برمی‌گردانید از موجودی خارج می‌کند.",
      },
      {
        id: "receive-purchase",
        kind: "action",
        verifier: "stock.received",
        title: "یک خرید را دریافت کنید",
        body:
          "از بخش «خرید» یک خرید با حداقل یک قلم ثبت و دریافت کنید. این مرحله با «بعدی» کامل نمی‌شود؛ وقتی سرور خرید را ثبت کند، خودکار تأیید می‌شود. اگر خرید واقعی ندارید، می‌توانید رد شوید.",
        eligibility: { permissions: [PERMISSIONS.purchasesManage] },
      },
      {
        id: "after-purchase",
        kind: "explain",
        title: "پس از دریافت",
        body:
          "خرید در فهرست خریدها و تاریخچهٔ انبار دیده می‌شود. اصلاح یا برگشت خرید از مسیر مجاز خودش انجام می‌شود، نه با تور.",
        eligibility: { permissions: [PERMISSIONS.purchasesManage] },
      },
    ],
  },
  {
    id: "accounting.products.new",
    version: 1,
    pageKey: "page:/accounting/products/new",
    route: "/accounting/products/new",
    title: "آشنایی با افزودن محصول",
    description: "با مشخصات اصلی، زبانه‌های قیمت و موجودی، تنوع‌ها و پیش‌نویس‌های فرم محصول آشنا شوید.",
    eligibility: { permissions: [PERMISSIONS.inventoryAdjust], industries: PRODUCT_WORKSPACE_INDUSTRIES },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "افزودن محصول",
        body:
          "فرم ثبت محصول ساده یا محصول چندتنوعی. این تور فرم را پر یا ذخیره نمی‌کند.",
      },
      {
        id: "identity",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.productNewIdentity,
        title: "مشخصات اصلی",
        body:
          "فقط نام محصول الزامی است. کد کالا و بارکد را دستی بنویسید یا با گزینهٔ «ایجاد خودکار» بسازید؛ اگر محصول فعلاً نباید فروخته شود، «این محصول فعلاً قابل فروش نیست» را بزنید. تصویر اصلی و گالری اختیاری است.",
      },
      {
        id: "tabs",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.productNewTabs,
        title: "بخش‌های فرم",
        body:
          "بقیهٔ اطلاعات در شش زبانه است: قیمت‌گذاری، عمومی، توضیحات و انتشار، سفارش، مالیات و تنوع‌ها. هر زبانه را هر زمان می‌توانید باز کنید و همه با یک بار ثبت ذخیره می‌شوند.",
      },
      {
        id: "pricing",
        kind: "explain",
        title: "قیمت و موجودی اولیه",
        body:
          "در زبانهٔ «قیمت‌گذاری» قیمت فروش (در صورت ورود باید بیشتر از صفر باشد)، قیمت خرید و موجودی اولیه را به واحد پولی که برای کسب‌وکار انتخاب کرده‌اید وارد می‌کنید. قیمت خرید بدون موجودی اولیه هم ثبت می‌شود.",
      },
      {
        id: "units",
        kind: "explain",
        title: "واحدها",
        body:
          "در زبانهٔ «عمومی» واحد اصلی را می‌نویسید. اگر واحد فرعی دارید، هر سه مقدار واحد اصلی، واحد فرعی و ضریب تبدیل را کامل کنید.",
      },
      {
        id: "order-tax-content",
        kind: "explain",
        title: "سفارش، مالیات و انتشار",
        body:
          "«سفارش» نقطهٔ سفارش و محل نگهداری را برای برنامه‌ریزی خرید ثبت می‌کند، «مالیات» درصدی بین صفر تا صد می‌گیرد، و «توضیحات و انتشار» متنی است که فروشگاه اینترنتی و وب‌سایت نشان می‌دهند.",
      },
      {
        id: "variants",
        kind: "explain",
        title: "تنوع‌ها",
        body:
          "اگر محصول چند رنگ یا سایز دارد، در زبانهٔ «تنوع‌ها» برای هر تنوع ویژگی، کد، بارکد، قیمت و موجودی جدا می‌گیرید. ابتدا باید در «ویژگی محصول» ویژگی‌هایی مثل رنگ یا سایز تعریف شده باشد.",
      },
      {
        id: "drafts",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.productNewDrafts,
        title: "پیش‌نویس‌ها",
        body:
          "فرم نیمه‌کاره را می‌توانید پیش‌نویس کنید و بعداً ادامه دهید. پیش‌نویس‌ها فقط روی همین دستگاه و برای همین شعبه نگه داشته می‌شوند.",
      },
      {
        id: "save",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.productNewSave,
        title: "ثبت محصول",
        body:
          "«ثبت محصول» فرم را ذخیره می‌کند و «ذخیره پیش‌نویس و فرم جدید» فرم را بدون ثبت کنار می‌گذارد. این تور هیچ‌کدام را نمی‌زند.",
      },
      {
        id: "save-verified",
        kind: "action",
        anchor: TOUR_ANCHORS.productNewSave,
        verifier: "product.created",
        title: "محصول را ثبت کنید",
        body:
          "دکمهٔ «ثبت محصول» را بزنید و محصول را در آنبار ثبت کنید. وقتی سرور ثبت محصول را تأیید کند، این مرحله خودکار کامل می‌شود. تور هرگز دکمهٔ ثبت را نمی‌زند.",
      },
    ],
  },
  {
    id: "accounting.products.prices",
    version: 1,
    pageKey: "page:/accounting/products/prices",
    route: "/accounting/products/prices",
    title: "آشنایی با به‌روزرسانی قیمت‌ها",
    description: "با جدول قیمت فروش و خرید، لیست‌های قیمت مرجع و بروزرسانی گروهی آشنا شوید.",
    eligibility: { permissions: [PERMISSIONS.inventoryView], industries: PRODUCT_WORKSPACE_INDUSTRIES },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "به‌روزرسانی قیمت‌ها",
        body:
          "قیمت فروش، قیمت خرید و لیست‌های قیمت همهٔ کالاها در یک جدول. این تور هیچ قیمتی را تغییر نمی‌دهد.",
      },
      {
        id: "csv",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pricesToolbar,
        title: "نوار ابزار",
        body: "«دانلود CSV لیست قیمت» جدول فعلی را به‌صورت فایل CSV می‌دهد.",
      },
      {
        id: "matrix",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pricesMatrix,
        title: "جدول قیمت‌ها",
        body:
          "«قیمت فروش» همان قیمتی است که در فاکتور و محاسبهٔ سود اعمال می‌شود. ستون‌های لیست‌های نام‌دار (مثل عمده یا همکار) فقط قیمت مرجع‌اند و نرخی را جای دیگر عوض نمی‌کنند. خانهٔ خالی یعنی قیمت ثبت نشده و صفر برای فروش پذیرفته نمی‌شود؛ «غیرقابل فروش» یعنی کالا برای فروش عرضه نشده است. با کادر جست‌وجو، نام، کد یا بارکد را فیلتر می‌کنید.",
      },
      {
        id: "history",
        kind: "explain",
        title: "تاریخچهٔ قیمت",
        body: "دکمهٔ «تاریخچهٔ قیمت» هر ردیف، تغییرهای ثبت‌شدهٔ قیمت همان کالا را نشان می‌دهد.",
      },
      {
        id: "edit-tools",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pricesToolbar,
        title: "بروزرسانی سریع و لیست‌ها",
        body:
          "«بروزرسانی سریع» یک تغییر را روی چند کالا اعمال می‌کند و پیش از اعمال، پیش‌نمایش و تأیید می‌خواهد. «مدیریت لیست‌های قیمت» برای ساخت، تغییر نام و حذف لیست‌های نام‌دار است.",
        eligibility: { permissions: [PERMISSIONS.inventoryAdjust] },
      },
      {
        id: "save-rules",
        kind: "explain",
        title: "ذخیرهٔ یکجا",
        body:
          "قیمت‌ها را مستقیم در خانه‌ها ویرایش می‌کنید و تا «ذخیره» را نزنید چیزی ثبت نمی‌شود؛ با خروج از صفحه بدون ذخیره هشدار می‌گیرید. اگر همزمان کس دیگری همان قیمت را عوض کرده باشد، برای هر مورد می‌توانید مقدار فعلی را بپذیرید یا مقدار خودتان را جایگزین کنید.",
        eligibility: { permissions: [PERMISSIONS.inventoryAdjust] },
      },
    ],
  },
  {
    id: "accounting.products.attributes",
    version: 1,
    pageKey: "page:/accounting/products/attributes",
    route: "/accounting/products/attributes",
    title: "آشنایی با ویژگی‌های محصول",
    description: "با تعریف ویژگی‌هایی مثل رنگ و سایز، مقدارهای مجاز و حذف یا غیرفعال‌سازی آن‌ها آشنا شوید.",
    eligibility: { permissions: [PERMISSIONS.inventoryView], industries: PRODUCT_WORKSPACE_INDUSTRIES },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "ویژگی‌های محصول",
        body:
          "ویژگی‌هایی مثل رنگ یا برند با مقدارهای مجازشان اینجا تعریف می‌شوند و در تنوع‌های محصول به‌کار می‌روند. این تور چیزی را تغییر نمی‌دهد.",
      },
      {
        id: "filters",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.attributesFilters,
        title: "جست‌وجو و وضعیت",
        body: "ویژگی را با نام جست‌وجو کنید یا فهرست را به فعال یا غیرفعال محدود کنید.",
      },
      {
        id: "cards",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.attributesCards,
        title: "کارت ویژگی‌ها",
        body:
          "هر کارت نام ویژگی، مقدارهای مجاز (یا «مقدار آزاد» اگر گزینهٔ ازپیش‌تعریف‌شده ندارد)، تعداد تنوع‌هایی که از آن استفاده می‌کنند و در صورت غیرفعال بودن، برچسب «غیرفعال» را نشان می‌دهد.",
      },
      {
        id: "add",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.attributesAdd,
        title: "افزودن و ویرایش",
        body:
          "«افزودن ویژگی» و منوی هر کارت، فرمی با نام، مقدارهای مجاز و وضعیت فعال یا غیرفعال باز می‌کند. اگر دو نفر همزمان یک ویژگی را ویرایش کنند، تعارض نشان داده می‌شود و چیزی بی‌صدا رونویسی نمی‌شود.",
        eligibility: { permissions: [PERMISSIONS.inventoryAdjust] },
      },
      {
        id: "delete-guard",
        kind: "explain",
        title: "حذف و غیرفعال‌سازی",
        body:
          "ویژگیِ استفاده‌نشده را می‌توان حذف کرد. ویژگی‌ای که در تنوع‌ها استفاده شده حذف نمی‌شود؛ به‌جایش آن را غیرفعال می‌کنید تا از استفادهٔ تازه جلوگیری شود و مقدارهای ثبت‌شدهٔ قبلی بماند.",
        eligibility: { permissions: [PERMISSIONS.inventoryAdjust] },
      },
    ],
  },
  {
    id: "accounting.products.reports",
    version: 1,
    pageKey: "page:/accounting/products/reports",
    route: "/accounting/products/reports",
    title: "آشنایی با گزارش‌های کالا",
    description: "ببینید گزارش فروش تنوع‌ها چه چیزی را نشان می‌دهد و سود موقت یعنی چه.",
    eligibility: { permissions: [PERMISSIONS.inventoryView], industries: PRODUCT_WORKSPACE_INDUSTRIES },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "گزارش‌های کالا",
        body: "گزارش فروش تنوع‌ها و خانواده‌های کالا. این صفحه فقط خواندنی است و این تور چیزی را تغییر نمی‌دهد.",
      },
      {
        id: "rows",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.productReportsRows,
        title: "تحلیل فروش تنوع‌ها",
        body:
          "هر ردیف یک تنوع (یا کالا) است: خانوادهٔ آن، ویژگی‌ها، تعداد فروخته‌شده، درآمد خالص، بهای تمام‌شده و حاشیه. فروش صندوق و فروش وب‌سایت (ووکامرس و فروشگاه سایت) هر دو حساب می‌شود.",
      },
      {
        id: "provisional",
        kind: "explain",
        title: "سود موقت",
        body:
          "فروشی که بهای تمام‌شده‌اش ثبت نشده با بهای صفر در حاشیه می‌آید، پس سود آن موقت است. برای دقیق‌تر شدن، بهای خرید کالا را در «به‌روزرسانی قیمت‌ها» ثبت کنید.",
      },
    ],
  },
  {
    id: "accounting.products.barcode-templates",
    version: 2,
    pageKey: "page:/accounting/products/barcode-templates",
    route: "/accounting/products/barcode-templates",
    title: "آشنایی با بارکد و برچسب محصولات",
    description: "قالب‌های برچسب سازگار با کسب‌وکار و پیش‌نمایش چاپ را ببینید.",
    eligibility: {
      industries: BARCODE_INDUSTRIES.filter(isRetailCatalogueIndustry),
      anyOf: [
        { industries: ["automotive"], permissions: [PERMISSIONS.vehiclesView] },
        { industries: BARCODE_INDUSTRIES.filter((industry) => industry !== "automotive"), permissions: [PERMISSIONS.inventoryView] },
      ],
    },
    steps: [
      {
        id: "label-welcome",
        kind: "explain",
        title: "بارکد و برچسب محصولات",
        body: "قالب‌ها و اندازهٔ کاغذ از سامانهٔ چاپ مشترک استفاده می‌کنند. این تور قالبی را انتخاب یا چاپ نمی‌کند.",
      },
      {
        id: "label-gallery",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.barcodeTemplates,
        title: "قالب‌ها و پیش‌نمایش",
        body: "قالب‌های مناسب این صنف را با داده‌های نمونه ببینید. مدیریت و انتخاب قالب به دسترسی تنظیمات نیاز دارد.",
      },
    ],
  },
  {
    id: "platform.learning-overview",
    version: 1,
    pageKey: "page:/workspace",
    route: "/workspace",
    title: "از میز کار من تا مرکز آموزش",
    description:
      "نقشهٔ کوتاه پلتفرم: میز کار، برنامه‌های کسب‌وکار، تنظیمات و مرکز آموزش — و اینکه از کجا یادگیری را ادامه دهید.",
    eligibility: {},
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "یک تور چندصفحه‌ای",
        body:
          "این تور شما را در چند صفحه همراهی می‌کند. هر جا لازم باشد صفحه عوض شود، خودتان دکمهٔ رفتن را می‌زنید؛ پیشرفتتان پیش از جابه‌جایی ذخیره می‌شود و اگر صفحه را دوباره باز کنید، از همان مرحله ادامه می‌دهید.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "میز کار من",
        body:
          "میز کار من کارهای شخصی شماست: پروژه‌ها، یادآوری‌ها و کارهایی که به شما سپرده شده. اینجا نقطهٔ شروع روز کاری است، نه جای عملیات فروش.",
      },
      {
        id: "apps",
        kind: "explain",
        title: "چهار برنامهٔ مستقل",
        body:
          "بیزامیز چهار برنامهٔ مستقل دارد: حسابداری (فروش، خرید و انبار، محصولات)، رشد و بازاریابی، ارتباط با مشتری (CRM) و مدیریت وب‌سایت. تنظیمات و مرکز آموزش بین همه مشترک‌اند. هر برنامه‌ای که برای کسب‌وکار شما فعال و برای نقش شما مجاز باشد در منو دیده می‌شود.",
      },
      {
        id: "to-knowledge",
        kind: "navigate",
        navigateTo: "/knowledge",
        title: "رفتن به مرکز آموزش",
        body:
          "حالا به مرکز آموزش می‌رویم تا ببینید مسیرهای یادگیری، پیشرفت شما و راهنماهای نوشته‌شده کجاست. این صفحه برای همهٔ اعضا باز است.",
      },
      {
        id: "knowledge-header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "مرکز آموزش",
        body:
          "اینجا خانهٔ یادگیری است: مقاله‌های کامل، جست‌وجو و پیوند به هر تیتر. از همین صفحه می‌توانید مسیرهای یادگیری و پیشرفت خودتان را هم ببینید.",
      },
      {
        id: "learning",
        kind: "explain",
        title: "مسیر یادگیری و پیشرفت",
        body:
          "«مسیرهای یادگیری» چند تور و راهنما را به یک هدف وصل می‌کنند (مثلاً اولین روز کاری). «پیشرفت من» نشان می‌دهد چه چیزی را کامل کرده‌اید، چه چیزی نیمه‌کاره مانده و قدم بعدی چیست. تورهای هر صفحه هم از دکمهٔ آموزش همان صفحه شروع می‌شوند.",
      },
    ],
  },
  {
    id: "growth.navigation.overview",
    version: 1,
    pageKey: "page:/growth/overview",
    route: "/growth/overview",
    title: "نقشهٔ رشد و بازاریابی",
    description: "از میز کار رشد به کمپین‌ها و باشگاه وفاداری؛ و اینکه هر بخش چه کاری برای شما انجام می‌دهد.",
    eligibility: {},
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "رشد یعنی چه",
        body:
          "برنامهٔ رشد، مشتری تازه می‌آورد و مشتری فعلی را نگه می‌دارد: مخاطبان، کمپین‌ها، پیام‌رسانی، کارت هدیه، وفاداری و پورسانت. اعداد این صفحه از همان فروش و عملیات کسب‌وکار می‌آید، نه از یک دفتر جدا.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "میز کار رشد",
        body: "خلاصهٔ عملکرد کمپین‌ها و مخاطبان. برای دیدن جزئیات هر بخش از منوی همین برنامه استفاده کنید.",
      },
      {
        id: "map",
        kind: "explain",
        title: "کجای این برنامه چه کاری می‌کند",
        body:
          "«مخاطبان» فهرست یکپارچهٔ مشتریان برای بازاریابی است. «کمپین‌ها» اجرای یک برنامه روی مخاطب هدف. «پیام‌رسانی» ارسال و پیگیری پیام است. «کارت هدیه» و «وفاداری» اعتبار و امتیاز مشتری را نگه می‌دارند. «پورسانت» سهم فروشندگان و بازاریابان را حساب می‌کند.",
      },
      {
        id: "to-campaigns",
        kind: "navigate",
        navigateTo: "/growth/campaigns",
        title: "رفتن به کمپین‌ها",
        body:
          "کمپین‌ها قلب این برنامه‌اند: یک پیشنهاد، یک مخاطب هدف و یک بازهٔ زمانی. کمپین پیش از اجرا تأیید می‌شود و ارسال واقعی از مسیر عادی خودش انجام می‌شود؛ تور هیچ پیامی نمی‌فرستد.",
      },
      {
        id: "campaigns",
        kind: "explain",
        title: "ساختن و سنجیدن کمپین",
        body:
          "برای هر کمپین، مخاطب هدف و پیام را مشخص می‌کنید و نتیجه را بر اساس فروش و پاسخ مخاطب می‌سنجید. گزارش‌ها به فروش همین کسب‌وکار وصل‌اند.",
      },
      {
        id: "to-loyalty",
        kind: "navigate",
        navigateTo: "/growth/loyalty",
        title: "رفتن به وفاداری",
        body: "باشگاه وفاداری جای نگه‌داشتن مشتری است: امتیاز، اعتبار و پاداش. به صفحهٔ وفاداری می‌رویم.",
      },
      {
        id: "loyalty",
        kind: "explain",
        title: "وفاداری و اعتبار",
        body:
          "اینجا قاعدهٔ کسب امتیاز و مصرف اعتبار را می‌بینید. موجودی اعتبار مشتری بخشی از حساب اوست؛ تغییر آن یک عملیات مالی واقعی است و این تور آن را انجام نمی‌دهد.",
      },
    ],
  },
  {
    id: "websites.navigation.overview",
    version: 1,
    pageKey: "page:/websites/overview",
    route: "/websites/overview",
    title: "نقشهٔ مدیریت وب‌سایت",
    description: "دو مدیر وب‌سایت در یک برنامه: سایت بیزامیز (CMS) و وردپرس/ووکامرس.",
    eligibility: {},
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "یک برنامه، دو مدیر سایت",
        body:
          "برنامهٔ وب‌سایت دو سیستم هم‌رده دارد: سایت بیزامیز (CMS) و مدیریت وردپرس/ووکامرس. هر دو از یک در باز می‌شوند، اما هر کدام داده و تنظیمات خودش را دارد؛ یکی را به‌جای دیگری نه.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "میز کار وب‌سایت‌ها",
        body: "اینجا وضعیت هر دو سایت را می‌بینید و می‌توانید وارد مدیر هر کدام شوید.",
      },
      {
        id: "map",
        kind: "explain",
        title: "از کدام مدیر شروع کنم",
        body:
          "اگر سایت را با بیزامیز ساخته‌اید، «سایت بیزامیز» را باز کنید: صفحه‌ها، نوشته‌ها، رسانه، محصولات، سفارش‌ها، طراحی، دامنه و اشتراک. اگر فروشگاه وردپرس دارید، «وردپرس» را باز کنید: محصولات، سفارش‌ها، مشتریان، دسته‌ها، محتوا، رسانه و صف رویدادها.",
      },
      {
        id: "to-cms",
        kind: "navigate",
        navigateTo: "/websites/cms",
        title: "رفتن به سایت بیزامیز",
        body: "اول مدیر سایت بیزامیز را می‌بینیم. اگر این سایت را ندارید، این مرحله را رد کنید.",
      },
      {
        id: "cms",
        kind: "explain",
        title: "مدیر سایت بیزامیز",
        body:
          "از اینجا محتوای سایت، محصولات و سفارش‌های فروشگاه سایت را مدیریت می‌کنید. تغییر طراحی یا دامنه اثر مستقیم روی سایت زنده دارد؛ تور چنین کاری انجام نمی‌دهد.",
      },
      {
        id: "to-wp",
        kind: "navigate",
        navigateTo: "/websites/wp",
        title: "رفتن به وردپرس",
        body:
          "حالا مدیر وردپرس را می‌بینیم. این بخش به اتصال فعال وردپرس نیاز دارد و فقط وقتی نمایش داده می‌شود که آن اتصال برای کسب‌وکار شما فعال باشد.",
        eligibility: { features: ["integrations"] },
      },
      {
        id: "wp",
        kind: "explain",
        title: "مدیر وردپرس",
        body:
          "محصولات، سفارش‌ها و مشتریان وردپرس از طریق اتصال همگام می‌شوند؛ «صف و رویدادها» نشان می‌دهد چه چیزی در انتظار ارسال یا دریافت است. برای عیب‌یابی، وضعیت اتصال را در تنظیمات اتصال‌ها ببینید.",
        eligibility: { features: ["integrations"] },
      },
    ],
  },
  {
    id: "accounting.navigation.overview",
    version: 1,
    pageKey: "page:/accounting/orders",
    route: "/accounting/orders",
    title: "نقشهٔ فضای حسابداری",
    description: "سفارش‌ها، صندوق فروش و محصولات؛ سه ایستگاه اصلی کار روزانه و راه رفتن بین آن‌ها.",
    eligibility: {},
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "حسابداری، فضای کار اصلی",
        body:
          "حسابداری فقط دفتر و سند نیست: فروش، خرید و انبار، محصولات و گزارش‌ها هم اینجا هستند. این تور سه ایستگاه پرکاربرد را به هم وصل می‌کند.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سفارش‌ها",
        body:
          "فهرست سفارش‌ها جای پیگیری سفارش‌های ثبت‌شده است. برای فروش تازه به صندوق می‌رویم؛ برای ساختن کالا به محصولات.",
      },
      {
        id: "map",
        kind: "explain",
        title: "ایستگاه‌های کار",
        body:
          "«صندوق فروش» ثبت فروش و دریافت وجه؛ «محصولات» کالا، قیمت و ویژگی‌ها؛ «انبار» موجودی و خرید. گزارش‌های کسب‌وکار و گزارش‌های مالی از همین داده‌ها ساخته می‌شوند.",
      },
      {
        id: "to-pos",
        kind: "navigate",
        navigateTo: "/accounting/pos",
        title: "رفتن به صندوق فروش",
        body:
          "به صندوق فروش می‌رویم. صفحهٔ صندوق برای هر صنف شکل خودش را دارد (سفارش کافه یا فاکتور فروشگاهی)؛ همان چیزی را می‌بینید که برای کسب‌وکار شما ساخته شده.",
        eligibility: { permissions: [PERMISSIONS.ordersCreate, PERMISSIONS.paymentsTake] },
      },
      {
        id: "cart",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.posCart,
        title: "سبد و پرداخت",
        body:
          "اقلام انتخابی اینجاست. جمع، تخفیف و روش پرداخت را همین‌جا می‌بینید و ثبت نهایی را خودتان انجام می‌دهید؛ تور دکمهٔ ثبت را نمی‌زند.",
        eligibility: { permissions: [PERMISSIONS.ordersCreate, PERMISSIONS.paymentsTake] },
      },
      {
        id: "pos",
        kind: "explain",
        title: "پس از فروش",
        body:
          "سفارش ثبت‌شده در فهرست سفارش‌ها و گزارش‌ها دیده می‌شود. اگر روش پرداخت یا مشتری را اشتباه زدید، اصلاح از مسیر مجاز همان صفحه انجام می‌شود، نه با تور.",
        eligibility: { permissions: [PERMISSIONS.ordersCreate, PERMISSIONS.paymentsTake] },
      },
      {
        id: "to-products",
        kind: "navigate",
        navigateTo: "/accounting/products",
        title: "رفتن به محصولات",
        body: "قدم بعدی ساختن یا به‌روزرسانی کالاست. به فهرست محصولات می‌رویم.",
        eligibility: {
          permissions: [PERMISSIONS.inventoryView],
          industries: PRODUCT_WORKSPACE_INDUSTRIES,
        },
      },
      {
        id: "products",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.productsKpis,
        title: "فهرست محصولات",
        body:
          "از اینجا کالای تازه می‌سازید، قیمت‌ها را به‌روز می‌کنید و وضعیت موجودی را می‌بینید. تغییر قیمت یا موجودی یک عملیات واقعی است و به دسترسی مناسب نیاز دارد.",
        eligibility: {
          permissions: [PERMISSIONS.inventoryView],
          industries: PRODUCT_WORKSPACE_INDUSTRIES,
        },
      },
    ],
  },
  {
    id: "settings.navigation.overview",
    version: 1,
    pageKey: "page:/settings",
    route: "/settings",
    title: "نقشهٔ تنظیمات پلتفرم",
    description: "تنظیمات کسب‌وکار، تیم و اتصال‌های فنی — و اینکه هر تغییر کجا اثر می‌گذارد.",
    eligibility: {},
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "تنظیمات، یک‌بار برای همه",
        body:
          "تنظیمات مشترک پلتفرم است: اطلاعات کسب‌وکار، تیم و دسترسی‌ها، روش‌های پرداخت، چاپ و اتصال‌ها. تغییر درست اینجا روی همهٔ برنامه‌ها اثر می‌گذارد؛ پس این تور فقط نقشه می‌دهد و چیزی را تغییر نمی‌دهد.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "صفحهٔ تنظیمات",
        body:
          "زبانه‌ها بر اساس نقش شما فیلتر می‌شوند: چیزی که اجازهٔ دیدنش را ندارید اصلاً نمایش داده نمی‌شود. تغییرهای حساس نیازمند دسترسی مدیریتی و در برخی موارد تأیید دوباره هستند.",
      },
      {
        id: "map",
        kind: "explain",
        title: "کجای تنظیمات چه کاری می‌کند",
        body:
          "اطلاعات کسب‌وکار و واحد پول، تیم و نقش‌ها، روش‌های پرداخت، چاپ و رسید، اعلان‌ها و پشتیبان‌گیری از بخش‌های اصلی‌اند. هر برنامه تنظیمات تخصصی خودش را هم دارد (مثلاً تنظیمات حسابداری یا CRM).",
      },
      {
        id: "change-access",
        kind: "action",
        verifier: "role.changed",
        title: "نقش یا دسترسی یک عضو را ذخیره کنید",
        body:
          "در بخش «تیم» یکی از اعضا را باز کنید و نقش، نقش سفارشی یا دسترسی‌هایش را تغییر دهید و ذخیره کنید. دلیل تغییر هم پرسیده می‌شود. این مرحله با «بعدی» کامل نمی‌شود؛ وقتی سرور تغییر را ذخیره کند، خودکار تأیید می‌شود. اگر عضو دیگری ندارید یا نمی‌خواهید دسترسی کسی را عوض کنید، می‌توانید رد شوید.",
        eligibility: { permissions: [PERMISSIONS.teamPermissionsManage] },
      },
      {
        id: "to-connections",
        kind: "navigate",
        navigateTo: "/settings/connections",
        title: "رفتن به اتصال‌ها",
        body:
          "اتصال‌های فنی مثل درگاه پرداخت، پیامک و وردپرس اینجاست. کلیدها و رمزها در این تور نمایش داده نمی‌شوند.",
        eligibility: { permissions: [PERMISSIONS.settingsManage] },
      },
      {
        id: "connections",
        kind: "explain",
        title: "اتصال‌های فنی",
        body:
          "هر اتصال وضعیت، آخرین بررسی و مالک دارد. قطع یا تغییر یک اتصال روی عملیات واقعی اثر می‌گذارد؛ فقط با هماهنگی و از مسیر تأییدشده انجامش دهید. برای دیدن آموزش هر اتصال، دکمهٔ آموزش همان بخش را بزنید.",
        eligibility: { permissions: [PERMISSIONS.settingsManage] },
      },
    ],
  },
  {
    id: "accounting.receivables.walkthrough",
    version: 1,
    pageKey: "page:/accounting/receivables",
    route: "/accounting/receivables",
    title: "کار با حساب‌های دریافتنی",
    description: "مشتریان بدهکار، مانده و سن بدهی را بخوانید و مسیر دریافت وجه را پیدا کنید.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "حساب‌های دریافتنی چیست",
        body:
          "هر فروش نسیه یک مطالبه از مشتری می‌سازد. این صفحه همان مطالبات را بر اساس شخص، مانده و مدت گذشته نشان می‌دهد؛ ثبت دریافت وجه از مسیر «دریافت و پرداخت» انجام می‌شود.",
      },
      {
        id: "search",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageFilters,
        title: "جست‌وجو و محدودکردن فهرست",
        body:
          "با جست‌وجوی نام یا شماره، فهرست را به یک مشتری محدود کنید. فیلترها همان چیزی را نشان می‌دهند که اجازهٔ دیدنش را دارید؛ تور چیزی را تغییر نمی‌دهد.",
      },
      {
        id: "table",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageTable,
        title: "ماندهٔ حساب مشتریان",
        body:
          "نمای «مانده حساب‌ها» هر مشتری را با شمارهٔ تماس و ماندهٔ حسابش نشان می‌دهد؛ ستون‌های سن بدهی در نمای «نمای سنی بدهی‌ها» بالای همان فهرست است. ردیف را باز کنید تا صورت‌حساب و سابقهٔ دریافت‌ها را ببینید؛ مبلغی را خودتان ثبت نمی‌کنید.",
      },
      {
        id: "to-receipts",
        kind: "navigate",
        navigateTo: "/accounting/receipts",
        title: "رفتن به ثبت دریافت",
        body:
          "برای ثبت دریافت واقعی به صفحهٔ «دریافت و پرداخت» می‌رویم. این صفحه فقط خواندنی است و دریافت را آنجا ثبت می‌کنید.",
        eligibility: { permissions: [PERMISSIONS.financeReceivablesManage] },
      },
      {
        id: "record-receipt",
        kind: "action",
        verifier: "receivable.payment_recorded",
        title: "یک دریافت ثبت کنید",
        body:
          "مشتری، روش دریافت و مبلغ را انتخاب کنید و سند دریافت را ثبت کنید. این مرحله با فشردن «بعدی» کامل نمی‌شود؛ وقتی سرور همان دریافت را ثبت کند، خودکار تأیید می‌شود. اگر دریافت واقعی ندارید، می‌توانید رد شوید.",
        eligibility: { permissions: [PERMISSIONS.financeReceivablesManage] },
      },
      {
        id: "done",
        kind: "explain",
        title: "پس از ثبت",
        body:
          "دریافت ثبت‌شده در همین فهرست و در صورت‌حساب مشتری دیده می‌شود. اگر اشتباه ثبت شد، اصلاح از مسیر مجاز همان برگه انجام می‌شود، نه با تور.",
        eligibility: { permissions: [PERMISSIONS.financeReceivablesManage] },
      },
    ],
  },
  {
    id: "accounting.payables.walkthrough",
    version: 1,
    pageKey: "page:/accounting/payables",
    route: "/accounting/payables",
    title: "کار با حساب‌های پرداختنی",
    description: "بدهی به تأمین‌کنندگان، مانده و سن بدهی را بخوانید و مسیر پرداخت را پیدا کنید.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "حساب‌های پرداختنی چیست",
        body:
          "خرید نسیه از تأمین‌کننده یک بدهی می‌سازد. این صفحه بدهی‌ها را بر اساس شخص، مانده و مدت گذشته نشان می‌دهد؛ پرداخت از مسیر «دریافت و پرداخت» ثبت می‌شود.",
      },
      {
        id: "search",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageFilters,
        title: "جست‌وجو و محدودکردن فهرست",
        body:
          "با نام یا شمارهٔ تأمین‌کننده فهرست را محدود کنید. فقط اشخاص و مبالغی دیده می‌شود که نقش شما اجازهٔ دیدنشان را دارد.",
      },
      {
        id: "table",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageTable,
        title: "ماندهٔ حساب تأمین‌کنندگان",
        body:
          "نمای «مانده حساب‌ها» هر تأمین‌کننده را با ماندهٔ حسابش نشان می‌دهد؛ ستون‌های سن بدهی در نمای «نمای سنی بدهی‌ها» بالای همان فهرست است. ردیف را باز کنید تا صورت‌حساب و سابقهٔ پرداخت‌ها را ببینید.",
      },
      {
        id: "record-payment",
        kind: "action",
        verifier: "payable.payment_recorded",
        title: "یک پرداخت ثبت کنید",
        body:
          "تأمین‌کننده، روش پرداخت و مبلغ را انتخاب کنید و سند پرداخت را ثبت کنید. این مرحله با فشردن «بعدی» کامل نمی‌شود؛ وقتی سرور همان پرداخت را ثبت کند، خودکار تأیید می‌شود. اگر پرداخت واقعی ندارید، می‌توانید رد شوید.",
        eligibility: { permissions: [PERMISSIONS.financePayablesManage] },
      },
      {
        id: "done",
        kind: "explain",
        title: "پس از ثبت",
        body:
          "پرداخت ثبت‌شده در همین فهرست و در صورت‌حساب تأمین‌کننده دیده می‌شود. اصلاح یا برگشت از مسیر مجاز همان سند انجام می‌شود، نه با تور.",
        eligibility: { permissions: [PERMISSIONS.financePayablesManage] },
      },
    ],
  },
  listPageTour({
    id: "accounting.entries.list",
    pageKey: "page:/accounting/entries",
    title: "دفتر روزنامه: خواندن سندها",
    description: "سندهای ثبت‌شده، فیلترها و مسیر ثبت سند تازه را ببینید.",
    introTitle: "دفتر روزنامه چیست",
    introBody:
      "هر سند یک رویداد مالی با تاریخ، شرح و ردیف‌های بدهکار/بستانکار است. این صفحه سندهای ثبت‌شده را نشان می‌دهد؛ ثبت سند تازه از «سند دستی» انجام می‌شود.",
    nextBody:
      "برای ثبت سند تازه به «سند دستی» بروید و برای دیدن ترازها از «تراز آزمایشی» استفاده کنید. تور هیچ سندی ثبت یا اصلاح نمی‌کند.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.expenses.list",
    pageKey: "page:/accounting/expenses",
    title: "هزینه‌ها: ثبت و پیگیری",
    description: "فهرست هزینه‌ها، وضعیت و مسیر ثبت هزینهٔ تازه.",
    introTitle: "هزینه‌ها",
    introBody:
      "هزینه‌های کسب‌وکار با دسته، مبلغ، تاریخ و وضعیت پرداخت اینجا نگه داشته می‌شوند. ثبت هزینه یک عملیات مالی واقعی است و از فرم خودش انجام می‌شود.",
    nextBody:
      "برای ثبت هزینهٔ تازه از دکمهٔ افزودن همین صفحه استفاده کنید. اگر هزینه به تأمین‌کننده بدهکار شده، تسویه از مسیر پرداخت‌ها انجام می‌شود.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.fixed-assets.list",
    pageKey: "page:/accounting/fixed-assets",
    title: "دارایی‌های ثابت و استهلاک",
    description: "دارایی‌ها، بهای تمام‌شده و برنامهٔ استهلاک را بشناسید.",
    introTitle: "دارایی ثابت چیست",
    introBody:
      "دارایی ثابت کالایی است که برای استفادهٔ بلندمدت نگه داشته می‌شود، نه برای فروش. هر دارایی بهای تمام‌شده، عمر مفید و استهلاک دوره‌ای دارد.",
    nextBody:
      "برای ثبت دارایی تازه از فرم همین صفحه استفاده کنید. استهلاک و کنارگذاری دارایی عملیات حسابداری واقعی‌اند و تور آن‌ها را انجام نمی‌دهد.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.installments.list",
    pageKey: "page:/accounting/installments",
    title: "اقساط و سررسیدها",
    description: "اقساط مشتریان، سررسید و وضعیت پرداخت را ببینید.",
    introTitle: "اقساط",
    introBody:
      "فروش اقساطی به چند قسط با سررسیدهای جدا تبدیل می‌شود. این صفحه اقساط و ماندهٔ هرکدام را نشان می‌دهد و از حساب دریافتنی همان مشتری می‌خواند.",
    nextBody:
      "برای ثبت پرداخت قسط از «دریافت و پرداخت» استفاده کنید. تغییر سررسید یا مبلغ یک اصلاح مالی است و از مسیر مجاز خودش انجام می‌شود.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.fiscal-periods.list",
    pageKey: "page:/accounting/fiscal-periods",
    title: "دوره‌های مالی و بستن",
    description: "سال مالی، دوره‌های بسته و وضعیت جاری را بخوانید.",
    introTitle: "دورهٔ مالی",
    introBody:
      "هر سال مالی به دوره‌هایی تقسیم می‌شود که سندها در آن‌ها ثبت می‌شوند. دورهٔ بسته دیگر سند تازه نمی‌پذیرد تا گزارش‌های همان دوره پایدار بمانند.",
    nextBody:
      "باز و بسته‌کردن دوره یک عملیات حساس است و از همین صفحه با تأیید انجام می‌شود. تور فقط وضعیت را توضیح می‌دهد.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.receipts.list",
    pageKey: "page:/accounting/receipts",
    title: "دریافت و پرداخت",
    description: "دریافت‌ها و پرداخت‌ها، روش‌ها و سندهای مرتبط را ببینید.",
    introTitle: "دریافت و پرداخت",
    introBody:
      "هر دریافت یا پرداخت یک سند نقدی می‌سازد و ماندهٔ طرف حساب را تغییر می‌دهد. این صفحه تاریخ، روش، مبلغ و طرف حساب را نشان می‌دهد.",
    nextBody:
      "برای ثبت دریافت یا پرداخت تازه از دکمهٔ افزودن همین صفحه استفاده کنید. اگر اشتباه شد، اصلاح یا برگشت از مسیر مجاز همان سند انجام می‌شود.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.chart-of-accounts.list",
    pageKey: "page:/accounting/chart-of-accounts",
    title: "سرفصل حساب‌ها",
    description: "درخت حساب‌ها، نوع و کدینگ را بشناسید.",
    introTitle: "سرفصل حساب‌ها",
    introBody:
      "هر سند به حساب‌های همین درخت می‌خورد. نوع حساب (دارایی، بدهی، سرمایه، درآمد، هزینه) تعیین می‌کند مانده در کدام گزارش دیده شود.",
    nextBody:
      "افزودن یا تغییر سرفصل یک تصمیم حسابداری است و از فرم خودش انجام می‌شود. پیش از تغییر، اثر آن را روی گزارش‌ها بسنجید.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "crm.deals.list",
    pageKey: "page:/crm/deals",
    title: "فرصت‌های فروش",
    description: "قیف فروش، مرحله و اقدام بعدی هر فرصت را ببینید.",
    introTitle: "فرصت فروش چیست",
    introBody:
      "هر فرصت یک معاملهٔ احتمالی با یک شخص است: مرحله، مبلغ، تاریخ بسته‌شدن و اقدام بعدی. جابه‌جایی مرحله، پیشرفت واقعی کار را نشان می‌دهد.",
    nextBody:
      "برای ساخت فرصت تازه از دکمهٔ افزودن استفاده کنید و برای پیگیری، کار یا تماس را از همان ردیف ثبت کنید. تور چیزی را تغییر نمی‌دهد.",
    eligibility: {
      anyOf: [{ permissions: [PERMISSIONS.crmView] }, { permissions: [PERMISSIONS.crmManage] }],
    },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    filters: true,
  }),
  listPageTour({
    id: "crm.activities.list",
    pageKey: "page:/crm/activities",
    title: "کارها و پیگیری‌ها",
    description: "تعهدهای زمانی، سررسید و اقدام بعدی را مدیریت کنید.",
    introTitle: "کار و پیگیری",
    introBody:
      "هر کار یک تعهد با سررسید و مسئول است: تماس، جلسه، یادآوری یا پیگیری. کارهای عقب‌افتاده در میز کار CRM هم دیده می‌شوند.",
    nextBody:
      "کار تازه را از دکمهٔ افزودن ثبت کنید و پس از انجام، نتیجه را در همان کار بنویسید. تغییر وضعیت کار یک عمل واقعی است و تور آن را انجام نمی‌دهد.",
    eligibility: {
      anyOf: [{ permissions: [PERMISSIONS.crmView] }, { permissions: [PERMISSIONS.crmManage] }],
    },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    filters: true,
  }),
  listPageTour({
    id: "crm.cases.list",
    pageKey: "page:/crm/cases",
    title: "تیکت‌های خدمات",
    description: "درخواست‌های پشتیبانی، وضعیت و مسئول را ببینید.",
    introTitle: "تیکت خدمات",
    introBody:
      "هر تیکت یک درخواست پشتیبانی با موضوع، اولویت، وضعیت و مسئول است. تاریخچهٔ پاسخ‌ها در همان تیکت می‌ماند.",
    nextBody:
      "برای ثبت تیکت تازه از دکمهٔ افزودن استفاده کنید. بستن تیکت بدون پاسخ دادن به مشتری، یک تصمیم واقعی است و تور آن را انجام نمی‌دهد.",
    eligibility: {
      anyOf: [{ permissions: [PERMISSIONS.crmView] }, { permissions: [PERMISSIONS.crmManage] }],
    },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    filters: true,
  }),
  listPageTour({
    id: "crm.leads.list",
    pageKey: "page:/crm/leads",
    title: "سرنخ‌ها",
    description: "سرنخ‌های تازه، منبع و مسیر تبدیل به مشتری.",
    introTitle: "سرنخ چیست",
    introBody:
      "سرنخ یک تماس یا علاقهٔ اولیه است که هنوز به مشتری یا فرصت تبدیل نشده. منبع سرنخ نشان می‌دهد از کدام کانال آمده است.",
    nextBody:
      "برای پیگیری، سرنخ را به فرصت یا مشتری تبدیل کنید یا کار پیگیری بسازید. این تبدیل یک تصمیم فروش است و تور آن را انجام نمی‌دهد.",
    eligibility: {
      anyOf: [{ permissions: [PERMISSIONS.crmView] }, { permissions: [PERMISSIONS.crmManage] }],
    },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    filters: true,
  }),
  listPageTour({
    id: "growth.customers.list",
    pageKey: "page:/growth/customers",
    title: "مخاطبان بازاریابی",
    description: "فهرست یکپارچهٔ مخاطبان، فیلترها و آمادگی برای کمپین.",
    introTitle: "مخاطب بازاریابی",
    introBody:
      "این فهرست از همان پروندهٔ اشخاص ساخته می‌شود، اما فقط برای کار بازاریابی است: مخاطب هدف، رضایت ارتباط و سابقهٔ خرید. تغییر رضایت ارتباط یک تصمیم قانونی است.",
    nextBody:
      "برای ساخت کمپین، مخاطبان را انتخاب و در بخش «کمپین‌ها» پیام و زمان‌بندی را مشخص کنید. تور هیچ پیامی نمی‌فرستد.",
    eligibility: { permissions: [PERMISSIONS.growthView] },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    filters: true,
    table: true,
  }),
  listPageTour({
    id: "growth.campaigns.list",
    pageKey: "page:/growth/campaigns",
    title: "کمپین‌های بازاریابی",
    description: "کمپین‌ها، مخاطب هدف، وضعیت و نتیجه را ببینید.",
    introTitle: "کمپین چیست",
    introBody:
      "هر کمپین یک پیشنهاد با مخاطب هدف و بازهٔ زمانی است. وضعیت کمپین نشان می‌دهد پیش‌نویس، در حال اجرا یا تمام‌شده است.",
    nextBody:
      "برای کمپین تازه از دکمهٔ افزودن استفاده کنید. تأیید و ارسال واقعی از مسیر خودش انجام می‌شود؛ تور پیامی نمی‌فرستد و پرداختی انجام نمی‌دهد.",
    eligibility: {
      anyOf: [
        { permissions: [PERMISSIONS.campaignsView] },
        { permissions: [PERMISSIONS.campaignsManage] },
      ],
    },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    filters: true,
  }),
  listPageTour({
    id: "websites.cms.overview",
    pageKey: "page:/websites/cms",
    title: "مدیر سایت بیزامیز",
    description: "محتوای سایت، محصولات، سفارش‌ها و طراحی را از یک مدیر بشناسید.",
    introTitle: "سایت بیزامیز چیست",
    introBody:
      "این مدیر، سایت ساخته‌شده با بیزامیز را اداره می‌کند: صفحه‌ها، نوشته‌ها، رسانه، محصولات و سفارش‌های فروشگاه سایت، طراحی، دامنه و اشتراک. هر تغییر در طراحی یا دامنه روی سایت زنده اثر دارد.",
    nextBody:
      "برای شروع، از «صفحه‌ها» یا «نوشته‌ها» محتوای موجود را ببینید. انتشار و تغییر دامنه عملیات واقعی‌اند و تور آن‌ها را انجام نمی‌دهد.",
    eligibility: {},
    navAnchor: TOUR_ANCHORS.appSectionNav,
  }),
  listPageTour({
    id: "websites.wp.overview",
    pageKey: "page:/websites/wp",
    title: "مدیر وردپرس و ووکامرس",
    description: "محصولات، سفارش‌ها، محتوا و صف همگام‌سازی وردپرس را بشناسید.",
    introTitle: "اتصال وردپرس",
    introBody:
      "این بخش یک فروشگاه وردپرس/ووکامرس متصل را مدیریت می‌کند: محصولات، سفارش‌ها، مشتریان، دسته‌ها، محتوا و رسانه. صف و رویدادها نشان می‌دهد چه چیزی در انتظار ارسال یا دریافت است.",
    nextBody:
      "برای عیب‌یابی، ابتدا وضعیت اتصال را در تنظیمات اتصال‌ها ببینید. همگام‌سازی، حذف یا تغییر محصول یک عملیات واقعی روی فروشگاه است و تور آن را انجام نمی‌دهد.",
    eligibility: { features: ["integrations"] },
    navAnchor: TOUR_ANCHORS.appSectionNav,
  }),
  listPageTour({
    id: "accounting.trial-balance.list",
    pageKey: "page:/accounting/trial-balance",
    title: "تراز آزمایشی",
    description: "جمع بدهکار و بستانکار هر حساب و تراز کل را بخوانید.",
    introTitle: "تراز آزمایشی چیست",
    introBody:
      "تراز آزمایشی ماندهٔ هر حساب را در یک بازه نشان می‌دهد و بررسی می‌کند جمع بدهکاران با جمع بستانکاران برابر باشد. این صفحه فقط خواندنی است.",
    nextBody:
      "برای دیدن جزئیات یک حساب، دفتر روزنامه یا گزارش‌های مالی را باز کنید. اگر تراز برابر نیست، ابتدا سندهای همان بازه را بررسی کنید.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.vouchers.list",
    pageKey: "page:/accounting/vouchers",
    title: "اسناد و شماره‌گذاری",
    description: "شمارهٔ سندها، وضعیت و ترتیب ثبت را ببینید.",
    introTitle: "شماره‌گذاری اسناد",
    introBody:
      "هر سند یک شمارهٔ یکتا در دورهٔ مالی دارد. این صفحه شماره‌ها و وضعیت سندها را نشان می‌دهد تا دنبالهٔ ثبت و شکاف‌ها را ببینید.",
    nextBody:
      "برای ثبت سند تازه از «سند دستی» استفاده کنید. تغییر شماره‌گذاری یا حذف سند از مسیر مجاز خودش و با تأیید انجام می‌شود.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.opening-balances.list",
    pageKey: "page:/accounting/opening-balances",
    title: "ترازات افتتاحیه",
    description: "مانده‌های آغاز دوره و وضعیت ثبت آن‌ها را ببینید.",
    introTitle: "تراز افتتاحیه",
    introBody:
      "تراز افتتاحیه ماندهٔ حساب‌ها را در شروع دوره نگه می‌دارد. این اعداد پایهٔ گزارش‌های دوره‌اند و باید با دارایی و بدهی واقعی بخوانند.",
    nextBody:
      "ورود یا اصلاح تراز افتتاحیه یک عملیات حسابداری حساس است و از فرم خودش با تأیید انجام می‌شود؛ تور آن را تغییر نمی‌دهد.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.reconciliation.list",
    pageKey: "page:/accounting/reconciliation",
    title: "تطبیق بانکی",
    description: "سندهای بانکی، موارد تطبیق‌نشده و مسیر رسیدگی را ببینید.",
    introTitle: "تطبیق بانکی",
    introBody:
      "صورت‌حساب بانک را با ثبت‌های دفتر مقایسه می‌کنید تا اختلاف‌ها پیدا شوند. تطبیق یک بازبینی است، نه تغییر خودکار مانده‌ها.",
    nextBody:
      "برای رسیدگی به هر اختلاف، سند مربوط را باز کنید. ثبت اصلاح از مسیر مجاز همان سند انجام می‌شود و تور چیزی را تغییر نمی‌دهد.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.multicurrency.list",
    pageKey: "page:/accounting/multicurrency",
    title: "ارز و تسعیر",
    description: "نرخ‌ها، اسناد ارزی و تفاوت تسعیر را بشناسید.",
    introTitle: "حسابداری چندارزی",
    introBody:
      "سند ارزی با نرخ همان تاریخ ثبت می‌شود و ماندهٔ ارزی جدا نگه داشته می‌شود. تسعیر، ماندهٔ ارزی را با نرخ تازه به پول پایه برمی‌گرداند.",
    nextBody:
      "ثبت نرخ یا تسعیر یک عملیات مالی واقعی است و از فرم خودش انجام می‌شود. پیش از تسعیر، نرخ و بازهٔ درست را بررسی کنید.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.dimensions.list",
    pageKey: "page:/accounting/dimensions",
    title: "ابعاد حسابداری",
    description: "مراکز هزینه، پروژه‌ها و تخصیص سندها را بشناسید.",
    introTitle: "بعد حسابداری",
    introBody:
      "ابعاد به سندها برچسب می‌دهند تا هزینه و درآمد را بر اساس پروژه، شعبه یا مرکز هزینه ببینید. خود بعد سند نمی‌سازد؛ فقط گزارش‌ها را دقیق‌تر می‌کند.",
    nextBody:
      "برای تعریف یا اتصال بعد، از تب‌های همین صفحه استفاده کنید. تغییر نگاشت ابعاد روی گزارش‌های آینده اثر دارد و باید آگاهانه باشد.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.payroll.list",
    pageKey: "page:/accounting/payroll",
    title: "حقوق و دستمزد",
    description: "دوره‌های حقوق، اقلام و وضعیت پرداخت را ببینید.",
    introTitle: "حقوق و دستمزد",
    introBody:
      "هر دورهٔ حقوق اقلام هر کارمند (پایه، اضافه‌کاری، کسورات) را جمع می‌کند و سند هزینه و بدهی می‌سازد. اطلاعات حقوقی از این صفحه به نقش‌های مجاز محدود است.",
    nextBody:
      "محاسبه، تأیید و پرداخت دوره عملیات مالی واقعی‌اند و از مسیر تأییدشده انجام می‌شوند. تور هیچ دستمزدی را تغییر نمی‌دهد.",
    eligibility: { permissions: [PERMISSIONS.payrollView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.tax-invoices.list",
    pageKey: "page:/accounting/tax-invoices",
    title: "صورتحساب مؤدیان",
    description: "صورتحساب‌های مالیاتی، وضعیت ارسال و پاسخ سامانه را ببینید.",
    introTitle: "صورتحساب مؤدیان",
    introBody:
      "این صفحه صورتحساب‌های الکترونیکی مالیاتی را نگه می‌دارد: شناسه، وضعیت ارسال و پاسخ سامانه. ارسال به سامانه یک عمل واقعی و برگشت‌ناپذیر است.",
    nextBody:
      "ارسال، اصلاح یا ابطال صورتحساب از مسیر مجاز و با تأیید انجام می‌شود. تور فقط وضعیت را توضیح می‌دهد و چیزی ارسال نمی‌کند.",
    eligibility: { permissions: [PERMISSIONS.taxView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "accounting.shareholders.list",
    pageKey: "page:/accounting/shareholders",
    title: "سهام‌داران و تقسیم سود",
    description: "سرمایه، سهام و توزیع سود را بشناسید.",
    introTitle: "سهام‌داران و سرمایه",
    introBody:
      "این بخش سهام هر شریک و تغییرات سرمایه را نگه می‌دارد. تقسیم سود از سود انباشته و با تصمیم مجاز انجام می‌شود.",
    nextBody:
      "افزودن شریک، تغییر سرمایه یا تقسیم سود عملیات حساس‌اند و از فرم خودش با تأیید انجام می‌شوند؛ تور آن‌ها را تغییر نمی‌دهد.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    navAnchor: TOUR_ANCHORS.accountingSectionNav,
    table: true,
  }),
  listPageTour({
    id: "growth.marketers.list",
    pageKey: "page:/growth/marketers",
    title: "بازاریابان و سرپرستی",
    description: "نوع همکاری، سرپرست و وضعیت فعال هر بازاریاب را بخوانید.",
    introTitle: "بازاریاب کیست",
    introBody:
      "بازاریاب می‌تواند کارمند، پیمانکار، همکار ارجاعی یا آژانس باشد. برای کارمند، عضویت فعال تیم در همان شعبه لازم است؛ ثبت همکار خارجی دسترسی به سامانه نمی‌دهد.",
    nextBody:
      "پیش از غیرفعال‌سازی، ماموریت‌های باز را تعیین تکلیف کنید. غیرفعال‌سازی سابقه را حذف نمی‌کند و وضعیت حساب کاربری عضو را تغییر نمی‌دهد.",
    eligibility: { permissions: [PERMISSIONS.marketersView] },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    table: true,
  }),
  listPageTour({
    id: "growth.marketing-targets.list",
    pageKey: "page:/growth/marketing-targets",
    title: "مقصدهای بازاریابی",
    description: "محل‌های بیرونی، شهر و شخص مرتبط را مدیریت کنید.",
    introTitle: "مقصد بازاریابی",
    introBody:
      "مقصد، محل بیرونی است که بازاریاب به آن مراجعه می‌کند و از شعبهٔ داخلی جداست. اتصال به شخص موجود، رضایت بازاریابی ایجاد نمی‌کند؛ رضایت جای خودش را دارد.",
    nextBody:
      "مقصد دارای ماموریت باز بایگانی نمی‌شود. برای تغییر شعبه یا شخص مرتبط، مقصد را بایگانی و از نو ثبت کنید تا سابقهٔ ماموریت‌ها دست‌نخورده بماند.",
    eligibility: { permissions: [PERMISSIONS.marketingTargetsView] },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    table: true,
  }),
  listPageTour({
    id: "growth.marketing-assignments.list",
    pageKey: "page:/growth/marketing-assignments",
    title: "ماموریت‌های بازاریابی",
    description: "ماموریت‌ها، مهلت، اولویت و وضعیت هر بازاریاب را ببینید.",
    introTitle: "ماموریت چیست",
    introBody:
      "هر ماموریت یک بازاریاب را به یک مقصد در همان شعبه وصل می‌کند و مهلت، اولویت و وضعیت دارد. تکمیل وظیفه به‌تنهایی مدرک ملاقات یا فروش نیست.",
    nextBody:
      "برای ثبت گزارش واقعی، بازاریاب از «ماموریت‌های من» گزارش تعامل ثبت می‌کند؛ تکمیل ماموریت جای آن گزارش را نمی‌گیرد.",
    eligibility: { permissions: [PERMISSIONS.marketingAssignmentsView] },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    table: true,
  }),
  listPageTour({
    id: "growth.my-marketing-assignments.list",
    pageKey: "page:/growth/my-marketing-assignments",
    title: "ماموریت‌های بازاریابی من",
    description: "کارهای منتسب به شما، اولویت و مسیر شروع و تکمیل.",
    introTitle: "کارهای من",
    introBody:
      "فقط ماموریت‌های منتسب به شما در شعبه‌های مجاز دیده می‌شود. با «شروع» وضعیت به در حال انجام و با «تکمیل» به تکمیل‌شده می‌رود.",
    nextBody:
      "گزارش تعامل، مدرک ملاقات است و جدا از تکمیل وظیفه ثبت می‌شود. تکمیل وظیفه به‌تنهایی پاداش یا فروش نمی‌سازد.",
    eligibility: { permissions: [PERMISSIONS.marketingAssignmentsSelf] },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    table: true,
  }),
  listPageTour({
    id: "growth.marketing-touchpoints.list",
    pageKey: "page:/growth/marketing-touchpoints",
    title: "تعامل‌های بازاریابی",
    description: "تماس و ملاقات‌های ثبت‌شده، کانال و سرنخ مرتبط را ببینید.",
    introTitle: "گزارش تعامل",
    introBody:
      "هر تعامل، تماس یا ملاقات یک بازاریاب با یک مقصد را با کانال و منبع ثبت می‌کند و می‌تواند به سرنخ CRM وصل شود.",
    nextBody:
      "برای دیدن سابقهٔ یک سرنخ، از پروندهٔ همان سرنخ استفاده کنید. ثبت تعامل تازه، رضایت پیام‌رسانی نمی‌سازد.",
    eligibility: { permissions: [PERMISSIONS.marketingAttributionView] },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    table: true,
  }),
  {
    id: "growth.messaging.overview",
    version: 1,
    pageKey: "page:/growth/messaging",
    route: "/growth/messaging",
    title: "پیام‌رسانی و کمپین پیام",
    description: "قالب‌ها، مخاطبان مجاز و صف ارسال پیامک و ایمیل.",
    eligibility: { permissions: [PERMISSIONS.campaignsView] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "پیام‌رسانی رشد",
        body:
          "قالب‌های پیامک و ایمیل، مخاطبان و کمپین‌های خروجی اینجا مدیریت می‌شوند. ارسال فقط برای مشتریانی است که رضایت ارتباط دارند.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "وضعیت ارسال",
        body:
          "وضعیت اتصال پیام‌رسانی و نرخ هر پیام بالای صفحه دیده می‌شود. قالب یا کمپین بدون اتصال سالم ارسال نمی‌شود.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی رشد",
        body:
          "از این منو بین مخاطبان، کمپین‌ها، پیام‌رسانی، کارت هدیه، وفاداری و پورسانت جابه‌جا می‌شوید؛ آیتم فعال همین صفحه است.",
      },
      {
        id: "audience",
        kind: "explain",
        title: "مخاطبِ مجاز",
        body:
          "با شروع ارسال، فهرست مشتریان مجاز همان لحظه ثابت می‌شود؛ افرادی که رضایت ندارند یا لغو کرده‌اند کنار گذاشته می‌شوند. تغییر فهرست بعد از شروع، ارسال را عوض نمی‌کند.",
      },
      {
        id: "templates",
        kind: "explain",
        title: "قالب و پیش‌نمایش",
        body:
          "هر قالب متن پیامک یا ایمیل و متغیرهایش را نگه می‌دارد. پیش از ارسال، پیش‌نمایش و تعداد بخش‌های پیامک را ببینید؛ ارسال واقعی است و بازگشت ندارد.",
      },
      {
        id: "next",
        kind: "explain",
        title: "پیش از ارسال انبوه",
        body:
          "برای آزمایش، یک قالب و مخاطب کوچک انتخاب کنید. گزارش تحویل و تأخیر صف در همین صفحه است؛ ارسال انبوه را بدون هماهنگی انجام ندهید.",
      },
    ],
  },
  {
    id: "growth.gift-cards.overview",
    version: 1,
    pageKey: "page:/growth/gift-cards",
    route: "/growth/gift-cards",
    title: "کارت هدیه",
    description: "صدور، استعلام، مصرف و ثبت انقضای کارت هدیه.",
    eligibility: { permissions: [PERMISSIONS.giftCardsView] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "کارت هدیه، یک بدهی",
        body:
          "صدور کارت، پول نقد را به حساب کارت هدیه (۲۴۲۰) می‌برد و مصرف آن از همان حساب کم می‌کند. درآمد فقط وقتی ثبت می‌شود که مشتری با کارت خرید کند.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سرصفحهٔ کارت هدیه",
        body:
          "عنوان و توضیح صفحه بالای آن است. موجودی و سابقهٔ کارت با جست‌وجوی کد در همین صفحه خوانده می‌شود.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی رشد",
        body:
          "کارت هدیه کنار وفاداری و پورسانت در منوی رشد است. هر بخش اجازهٔ دسترسی خودش را دارد و موارد غیرمجاز نمایش داده نمی‌شوند.",
      },
      {
        id: "permissions",
        kind: "explain",
        title: "سه اجازهٔ جدا",
        body:
          "استعلام مانده، صدور و مصرف سه اجازهٔ جدا هستند. کسی که فقط مانده را می‌بیند نمی‌تواند کارت صادر یا مصرف کند.",
      },
      {
        id: "expiry",
        kind: "explain",
        title: "انقضا",
        body:
          "اگر انقضا در تنظیمات رشد فعال باشد، کارت منقضی قابل خرج نیست. «ثبت انقضا» ماندهٔ خرج‌نشده را یک‌بار از ۲۴۲۰ به سایر درآمدها می‌برد.",
      },
      {
        id: "next",
        kind: "explain",
        title: "عملیات واقعی",
        body:
          "صدور، مصرف و ثبت انقضا حرکات واقعی مالی‌اند و از فرم خودشان انجام می‌شوند؛ تور هیچ کارتی صادر یا باطل نمی‌کند.",
      },
    ],
  },
  {
    id: "growth.loyalty.overview",
    version: 1,
    pageKey: "page:/growth/loyalty",
    route: "/growth/loyalty",
    title: "وفاداری و اعتبار مشتری",
    description: "برنامهٔ امتیاز، مشتریان آمادهٔ خرید مجدد و اعتبار فروشگاهی.",
    eligibility: { permissions: [PERMISSIONS.loyaltyView] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "برنامهٔ وفاداری",
        body:
          "هر برنامه نرخ کسب امتیاز، ارزش هر امتیاز و مدت انقضا را تعیین می‌کند. مانده‌ها از دفتر امتیاز و رویدادهای حسابداری خوانده می‌شوند، نه از یک ستون قابل ویرایش.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سرصفحهٔ وفاداری",
        body:
          "عنوان صفحه و وضعیت برنامهٔ پیش‌فرض بالای آن است. برنامهٔ پیش‌فرض همان است که در فروش عادی امتیاز می‌دهد.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی رشد",
        body:
          "این صفحه در منوی رشد، کنار مخاطبان، کمپین‌ها و کارت هدیه قرار دارد. فقط بخش‌های مجاز نقش شما در منو دیده می‌شود.",
      },
      {
        id: "repeat",
        kind: "explain",
        title: "خرید مجدد",
        body:
          "«مشتریان آمادهٔ خرید مجدد» از تاریخچهٔ خرید همان مشتری در شعبهٔ فعال پیش‌بینی می‌شود؛ موعد گذشته یعنی وقت تماس یا پیام است.",
      },
      {
        id: "credit",
        kind: "explain",
        title: "مشتری و اعتبار",
        body:
          "در این بخش مانده و اعتبار فروشگاهی مشتری را می‌بینید. صدور یا بازپرداخت اعتبار یک عمل مالی جدا با اجازهٔ خودش است.",
      },
      {
        id: "next",
        kind: "explain",
        title: "اثر تغییرها",
        body:
          "تغییر برنامه روی کسب امتیاز آینده اثر دارد، نه مانده‌های قبلی. مصرف امتیاز در صندوق با اجازهٔ «مصرف امتیاز» انجام می‌شود.",
      },
    ],
  },
  {
    id: "growth.commission.overview",
    version: 1,
    pageKey: "page:/growth/commission",
    route: "/growth/commission",
    title: "پورسانت فروشندگان",
    description: "قوانین پورسانت، رتبه‌بندی و مبنای محاسبه.",
    eligibility: { permissions: [PERMISSIONS.commissionView] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "پورسانت چگونه ساخته می‌شود",
        body:
          "هر خط فروش به خاص‌ترین قانون پورسانت می‌رسد: کالا، سپس برند، سپس دسته و در پایان قانون کلی. مبنای حاشیه از همان بهای تمام‌شدهٔ COGS استفاده می‌کند.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سرصفحهٔ پورسانت",
        body:
          "عنوان و توضیح صفحه بالای آن است. این صفحه گزارش و قوانین را نشان می‌دهد؛ پرداخت پورسانت از مسیر تسویهٔ خودش انجام می‌شود.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی رشد",
        body:
          "پورسانت یکی از بخش‌های منوی رشد است. داده‌های حقوقی و پورسانت فقط برای نقش‌هایی نمایش داده می‌شود که اجازهٔ دیدن دارند.",
      },
      {
        id: "leaderboard",
        kind: "explain",
        title: "رتبه‌بندی",
        body:
          "رتبه‌بندی، مجموع پورسانت انباشته در بازهٔ انتخابی است؛ همان عددی که به‌عنوان بدهی حقوق ثبت شده. بازه را با تاریخ شمسی انتخاب کنید.",
      },
      {
        id: "rules",
        kind: "explain",
        title: "قوانین",
        body:
          "قانون حذف نمی‌شود، غیرفعال می‌شود تا تاریخچهٔ تسویه حفظ شود. میان قوانین هم‌سطح، اولویت بزرگ‌تر برنده است.",
      },
      {
        id: "next",
        kind: "explain",
        title: "اثر قانون تازه",
        body:
          "ساخت یا تغییر قانون روی فروش‌های آینده اثر دارد. پرداخت و تسویهٔ پورسانت از مسیر تأییدشدهٔ خودش انجام می‌شود، نه با تور.",
      },
    ],
  },
  {
    id: "growth.torob.overview",
    version: 1,
    pageKey: "page:/growth/torob",
    route: "/growth/torob",
    title: "کانال ترب",
    description: "سایت‌های قابل انتشار، وضعیت اتصال و آنچه ترب می‌گوید.",
    eligibility: { permissions: [PERMISSIONS.torobView] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "ترب و سایت‌های بیزامیز",
        body:
          "ترب فقط از سایت‌هایی منتشر می‌کند که در بیزامیز ساخته و فعالانه وصل شده‌اند. این صفحه نشان می‌دهد کدام سایت‌ها می‌توانند منتشر کنند و ترب چه می‌گوید.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سرصفحهٔ ترب",
        body:
          "عنوان و توضیح صفحه بالای آن است. وضعیت کلی کانال و نتیجهٔ آخرین اقدام مجوزدهی در همین نوار دیده می‌شود.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی رشد",
        body:
          "ترب یک بخش داخل رشد است، نه برنامهٔ جدا. از همین منو به وب‌سایت‌ها و سایر بخش‌های رشد می‌رسید.",
      },
      {
        id: "states",
        kind: "explain",
        title: "معنی «متصل»",
        body:
          "«متصل» یعنی ترب اجازهٔ انتشار داده است، نه اینکه محصولی در ترب دیده می‌شود. وضعیت هر فروشگاه را همان ترب اعلام می‌کند و در صفحهٔ همان فروشگاه دیده می‌شود.",
      },
      {
        id: "next",
        kind: "explain",
        title: "اتصال و قطع",
        body:
          "اتصال، مجوزدهی و قطع کانال روی فهرست زندهٔ ترب اثر دارد و با اجازهٔ «مدیریت ترب» انجام می‌شود. تور چیزی را وصل یا قطع نمی‌کند.",
      },
    ],
  },
  {
    id: "growth.settings.overview",
    version: 1,
    pageKey: "page:/growth/settings",
    route: "/growth/settings",
    title: "تنظیمات رشد",
    description: "پنجرهٔ اسناد، سقف تخفیف و اعتبار کارت هدیه.",
    eligibility: { permissions: [PERMISSIONS.marketingConfigure] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "تنظیمات سراسری رشد",
        body:
          "این صفحه تنظیمات سراسری رشد را نگه می‌دارد: پنجرهٔ اسناد بازاریابی، سقف تخفیف ۳۰ روزه و اعتبار اختیاری کارت هدیه. همین اعداد در گزارش‌ها و فرمان‌ها خوانده می‌شوند.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سرصفحهٔ تنظیمات رشد",
        body:
          "عنوان و وضعیت آمادگی رشد بالای صفحه است. هشدار آمادگی یعنی یک موتور هنوز پیکربندی نشده و باید پیش از استفاده بررسی شود.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی رشد",
        body:
          "این تنظیمات مخصوص رشد است، نه تنظیمات کل پلتفرم. هر بخش تنظیمات تخصصی خودش را دارد و از همین منو باز می‌شود.",
      },
      {
        id: "elsewhere",
        kind: "explain",
        title: "چه چیزی اینجا نیست",
        body:
          "برنامهٔ وفاداری، آمادگی پیام‌رسانی و قوانین پورسانت هرکدام صفحهٔ خودشان را دارند. اینجا فقط میان‌بر و هشدار آمادگی نشان داده می‌شود.",
      },
      {
        id: "next",
        kind: "explain",
        title: "پیش از ذخیره",
        body:
          "ذخیرهٔ تنظیمات محاسبات آینده را عوض می‌کند. پیش از گستردن پنجرهٔ اسناد یا سقف تخفیف، اثر مالی آن را با حسابداری هماهنگ کنید.",
      },
    ],
  },
  listPageTour({
    id: "crm.briefs.list",
    pageKey: "page:/crm/briefs",
    title: "بریف کارفرما",
    description: "خواستهٔ مشتری، بودجه و تصمیم‌گیرنده پیش از قیمت‌گذاری.",
    introTitle: "بریف چیست",
    introBody:
      "بریف، خواستهٔ کارفرما را پیش از قیمت‌گذاری و اجرا ثبت می‌کند: دامنهٔ کار، بودجه و تصمیم‌گیرنده. تأیید بریف شکل آن را قطعی می‌کند و اصلاح بعدی با بریف جانشین انجام می‌شود.",
    nextBody:
      "پیشنهاد قیمت روی همین بریف ساخته می‌شود. حذف بریف فقط تا پیش از تأیید و با اجازهٔ حذف ممکن است؛ سابقهٔ خواستهٔ مشتری را نگه دارید.",
    eligibility: {
      permissions: [PERMISSIONS.crmView, PERMISSIONS.crmManage],
      anyOf: [
        { permissions: [PERMISSIONS.crmExport] },
        { permissions: [PERMISSIONS.crmConfigure] },
      ],
    },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    table: true,
  }),
  listPageTour({
    id: "crm.proposals.list",
    pageKey: "page:/crm/proposals",
    title: "پیشنهاد قیمت",
    description: "قیمت، حاشیه و وضعیت پیشنهاد تا پذیرش یا رد.",
    introTitle: "پیشنهاد قیمت",
    introBody:
      "پیشنهاد، قیمت و حاشیهٔ یک بریف را ثبت می‌کند و تا پذیرش، رد یا انقضا پیش می‌رود. حاشیه داخلی است و در نمای مشتری دیده نمی‌شود.",
    nextBody:
      "پس از ارسال، پیشنهاد قفل می‌شود؛ اصلاح با «پیشنهاد تازه از روی این» انجام می‌شود تا عددی که مشتری دیده تغییر نکند.",
    eligibility: {
      permissions: [PERMISSIONS.crmView, PERMISSIONS.crmManage],
      anyOf: [
        { permissions: [PERMISSIONS.crmExport] },
        { permissions: [PERMISSIONS.crmConfigure] },
      ],
    },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    table: true,
  }),
  listPageTour({
    id: "crm.client-campaigns.list",
    pageKey: "page:/crm/client-campaigns",
    title: "کمپین کارفرما",
    description: "بازه، کانال‌ها، هزینهٔ رسانه و اعداد بازگشتی.",
    introTitle: "کمپین کارفرما",
    introBody:
      "کمپین کارفرما ثبت می‌کند چه زمانی، در چه کانال‌هایی و با چه هزینهٔ رسانه‌ای اجرا شد و چه اعدادی برگشت. هیچ عددی حدس زده نمی‌شود؛ مخرج صفر «—» نشان می‌دهد.",
    nextBody:
      "کمپین تکمیل یا لغوشده قفل است و اصلاح آن یک کمپین تازه است. روش انتساب را کنار عدد درآمد ثبت کنید تا گزارش قابل دفاع باشد.",
    eligibility: {
      permissions: [PERMISSIONS.crmView, PERMISSIONS.crmManage],
      anyOf: [
        { permissions: [PERMISSIONS.crmExport] },
        { permissions: [PERMISSIONS.crmConfigure] },
      ],
    },
    navAnchor: TOUR_ANCHORS.appSectionNav,
    table: true,
  }),
  {
    id: "crm.persons.overview",
    version: 1,
    pageKey: "page:/crm/persons",
    route: "/crm/persons",
    title: "پروندهٔ مشتری",
    description: "جست‌وجوی مشتری و باز کردن پروندهٔ ۳۶۰ درجه.",
    eligibility: { permissions: [PERMISSIONS.crmView, PERMISSIONS.partiesView] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "پروندهٔ ۳۶۰ درجه",
        body:
          "این صفحه نقطهٔ شروع پروندهٔ مشتری است: نام یا شماره را جست‌وجو کنید تا خریدها، یادداشت‌ها، تیکت‌ها و وضعیت رضایت یک نفر در یک جا دیده شود.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سرصفحهٔ پرونده",
        body:
          "عنوان و توضیح این صفحه بالای آن است. تا مشتری انتخاب نشود، پرونده‌ای باز نمی‌شود.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی CRM",
        body:
          "پروندهٔ مشتری از منوی CRM باز می‌شود. فهرست مشتریان برای مدیریت چند رکورد است و پرونده برای فهم یک نفر؛ هر دو از یک دفتر اشخاص می‌خوانند.",
      },
      {
        id: "difference",
        kind: "explain",
        title: "پرونده یا فهرست",
        body:
          "تغییر مشخصات از دفتر اشخاص و تغییر رضایت کنار همان پرونده انجام می‌شود. پرونده جای فهرست را نمی‌گیرد و فهرست جای پرونده را.",
      },
      {
        id: "next",
        kind: "explain",
        title: "قدم بعد",
        body:
          "برای اصلاح مشخصات از دفتر اشخاص یا دکمهٔ ویرایش پرونده استفاده کنید. این تور چیزی را تغییر نمی‌دهد.",
      },
    ],
  },
  {
    id: "crm.segments.overview",
    version: 1,
    pageKey: "page:/crm/segments",
    route: "/crm/segments",
    title: "بخش‌بندی مشتری",
    description: "قانون بخش، پیش‌نمایش جمعیت و مخاطب قابل تماس.",
    eligibility: { permissions: [PERMISSIONS.crmView, PERMISSIONS.crmConfigure] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "بخش، یک سند قانون",
        body:
          "بخش‌بندی یک سند قانون است، نه پرس‌وجوی SQL: فیلدها و عملگرها از فهرست بسته می‌آیند و مقدارها پارامتر می‌شوند.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سرصفحهٔ بخش‌بندی",
        body:
          "عنوان و توضیح صفحه بالای آن است. بخش‌ها برای مخاطب کمپین و گزارش ساخته می‌شوند، نه برای حذف مشتری.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی CRM",
        body:
          "بخش‌بندی کنار مشتریان، فرصت‌ها و کمپین کارفرما در منوی CRM است. فقط بخش‌های مجاز نقش شما نمایش داده می‌شود.",
      },
      {
        id: "preview",
        kind: "explain",
        title: "پیش‌نمایش جمعیت",
        body:
          "پیش‌نمایش دو عدد نشان می‌دهد: چند مشتری با قانون می‌خوانند و چند نفر از آن‌ها برای هدف انتخابی قابل تماس‌اند. فاصلهٔ این دو، تصمیم کمپین را می‌سازد.",
      },
      {
        id: "next",
        kind: "explain",
        title: "اثر تغییر قانون",
        body:
          "تغییر قانون روی کمپین‌های بعدی اثر دارد. حذف بخش، مشتریان را حذف نمی‌کند.",
      },
    ],
  },
  {
    id: "crm.consent.overview",
    version: 1,
    pageKey: "page:/crm/consent",
    route: "/crm/consent",
    title: "رضایت ارتباط",
    description: "پوشش رضایت پیامک و ایمیل و دفتر تغییرات.",
    eligibility: { permissions: [PERMISSIONS.crmConsentManage] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "پوشش و دفتر",
        body:
          "رضایت ارتباط دو چیز را کنار هم نشان می‌دهد: پوشش («چند مشتری را می‌توانیم پیام دهیم») و دفتر تغییرات («چه زمانی و چرا عوض شد»).",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سرصفحهٔ رضایت",
        body:
          "عنوان و توضیح صفحه بالای آن است. این گزارش برای پاسخ به شکایت یا بازبینی قانونی نگه داشته می‌شود.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی CRM",
        body:
          "رضایت ارتباط بخشی از CRM است و از همین منو باز می‌شود. تنظیمات CRM فقط میان‌بری به این صفحه دارد.",
      },
      {
        id: "trail",
        kind: "explain",
        title: "دفتر فقط افزودنی",
        body:
          "دفتر فقط افزودنی است؛ ویرایش یا حذف ندارد، چون سندی که بتوان بازنویسی کرد مدرک نیست.",
      },
      {
        id: "change",
        kind: "explain",
        title: "کجا تغییر می‌کند",
        body:
          "رضایت کنار پروندهٔ خود مشتری تغییر می‌کند، نه از این صفحه. سطح ویرایش گروهی برای اجازهٔ پیام عمداً وجود ندارد.",
      },
      {
        id: "next",
        kind: "explain",
        title: "قدم بعد",
        body:
          "برای تغییر رضایت، پروندهٔ همان مشتری را باز کنید. این صفحه فقط می‌خواند.",
      },
    ],
  },
  {
    id: "crm.quality.overview",
    version: 1,
    pageKey: "page:/crm/quality",
    route: "/crm/quality",
    title: "کیفیت داده",
    description: "مسائل داده، اشخاص تکراری و تطبیق فروشگاه آنلاین.",
    eligibility: { permissions: [PERMISSIONS.crmMerge] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "یک کارگاه، سه پرسش",
        body:
          "کیفیت داده یک کارگاه است: مسائل داده، اشخاص تکراری و تطبیق فروشگاه آنلاین همه به یک تصمیم می‌رسند — اصلاح رکورد.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سرصفحهٔ کیفیت داده",
        body:
          "عنوان و توضیح صفحه بالای آن است. هر نمای این کارگاه با همان کلید ادغام باز می‌شود.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی CRM",
        body:
          "کیفیت داده کنار مشتریان و بخش‌بندی در منوی CRM است. نمای غیرمجاز نقش شما اصلاً کشیده نمی‌شود.",
      },
      {
        id: "issues",
        kind: "explain",
        title: "مسائل نام‌دار",
        body:
          "مسائل نام‌دار با شمار واقعی فهرست می‌شوند؛ امتیاز کلی ساخته نمی‌شود چون عددی است که نمی‌توان روی آن کار کرد.",
      },
      {
        id: "merge",
        kind: "explain",
        title: "ادغام با تأیید انسان",
        body:
          "ادغام خودکار وجود ندارد. نمای تکرار پیش‌نمایش می‌دهد و تأیید انسان لازم است؛ تطبیق هم انتخاب انسان می‌خواهد.",
      },
      {
        id: "next",
        kind: "explain",
        title: "قدم بعد",
        body:
          "از هر مسئله به رکورد خودش بروید. ادغام برگشت‌ناپذیر است و باید با اجازهٔ ادغام انجام شود.",
      },
    ],
  },
  {
    id: "crm.audit.overview",
    version: 1,
    pageKey: "page:/crm/audit",
    route: "/crm/audit",
    title: "سابقهٔ تصمیم‌ها",
    description: "چه کسی، چه زمانی و چرا تصمیم گرفت.",
    eligibility: { permissions: [PERMISSIONS.crmConfigure] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "دفتر تصمیم‌ها",
        body:
          "سابقهٔ تصمیم‌ها فقط قضاوت‌هایی را نگه می‌دارد که ردیف طبیعی ندارند: ادغام، تغییر رضایت و تصمیم کیفیت. خریدهای مشتری اینجا نیستند.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سرصفحهٔ سابقه",
        body:
          "عنوان و توضیح صفحه بالای آن است. این گزارش دربارهٔ کار کارکنان است، نه تاریخچهٔ خرید مشتری.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی CRM",
        body:
          "سابقهٔ تصمیم‌ها در منوی CRM است و فقط برای نقش‌هایی نمایش داده می‌شود که اجازهٔ پیکربندی دارند.",
      },
      {
        id: "filters",
        kind: "explain",
        title: "فیلترهای زنده",
        body:
          "فیلتر نوع و فاعل از خود گزارش ساخته می‌شود، نه از فهرست ثابت؛ گزینه‌ای که هرگز رخ نداده نمایش داده نمی‌شود.",
      },
      {
        id: "trail",
        kind: "explain",
        title: "تفاوت با تاریخچهٔ مشتری",
        body:
          "این گزارش فقط رشد می‌کند. برای تاریخچهٔ کامل یک مشتری از پروندهٔ او استفاده کنید.",
      },
      {
        id: "next",
        kind: "explain",
        title: "قدم بعد",
        body:
          "برای پاسخ به «چه کسی و چه زمانی» از همین صفحه استفاده کنید. این تور چیزی را تغییر نمی‌دهد.",
      },
    ],
  },
  {
    id: "crm.settings.overview",
    version: 1,
    pageKey: "page:/crm/settings",
    route: "/crm/settings",
    title: "تنظیمات CRM",
    description: "تشخیص تکرار، رضایت، قیف، فیلدها و اتوماسیون.",
    eligibility: { permissions: [PERMISSIONS.crmConfigure] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "تنظیمات همین برنامه",
        body:
          "تنظیمات CRM مخصوص همین برنامه است: تشخیص تکرار، رضایت، قیف و مراحل فروش، فیلدهای کسب‌وکار و میان‌بر اتوماسیون.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سرصفحهٔ تنظیمات CRM",
        body:
          "عنوان و توضیح صفحه بالای آن است. تنظیمات سراسری پلتفرم در /settings است، نه اینجا.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی CRM",
        body:
          "این تنظیمات از منوی CRM باز می‌شود. هر گروه یا خود تنظیم را دارد یا به صفحهٔ صاحبش وصل می‌شود.",
      },
      {
        id: "groups",
        kind: "explain",
        title: "گروه‌های تنظیم",
        body:
          "تشخیص تکرار و رضایت به کارگاه کیفیت و دفتر رضایت وصل می‌شوند؛ قیف و فیلدها همین‌جا ویرایش می‌شوند.",
      },
      {
        id: "automations",
        kind: "explain",
        title: "اتوماسیون",
        body:
          "قواعد خودکار («وقتی → اگر → آنگاه») از همین تنظیمات باز می‌شوند و با قوی‌ترین کلید CRM نوشته می‌شوند، چون بدون ناظر رکورد تغییر می‌دهند.",
      },
      {
        id: "next",
        kind: "explain",
        title: "پیش از تغییر",
        body:
          "تغییر قیف یا فیلدها روی گزارش‌های آینده اثر دارد. پیش از تغییر مرحله‌ها با تیم فروش هماهنگ کنید.",
      },
    ],
  },
  websitePageTour({
    id: "websites.cms.setup.page",
    pageKey: "page:/websites/cms/setup",
    title: "ساخت سایت",
    description: "دامنه، CDN، نوع سایت و ساخت روی سایت‌ساز.",
    eligibility: { permissions: [PERMISSIONS.cmsView] },
    intro: {
      title: "چهار گام تا سایت",
      body:
        "ساخت سایت چهار گام دارد: دامنه (خرید از بیزامیز یا اتصال دامنهٔ خودتان)، CDN ابر آروان، نوع سایت (کسب‌وکار، نمونه‌کار یا فروشگاه) و ساخت روی سایت‌ساز.",
    },
    details: [
      {
        title: "ترتیب گام‌ها",
        body:
          "هر گام وضعیت خودش را دارد و گام بعدی تا کامل نشدن قبلی جلو نمی‌رود. اگر ساخت نیمه‌کاره بماند، همین صفحه نشان می‌دهد کجا متوقف شده است.",
      },
      {
        title: "دامنه و CDN",
        body:
          "دامنه و CDN پیش از ساخت تعیین می‌شوند. تغییر بعدی دامنه روی آدرس عمومی سایت اثر دارد و باید آگاهانه باشد.",
      },
    ],
    nextBody: "ساخت سایت یک عمل واقعی است. این تور فقط گام‌ها را توضیح می‌دهد و چیزی را نمی‌سازد.",
  }),
  websitePageTour({
    id: "websites.cms.pages.page",
    pageKey: "page:/websites/cms/pages",
    title: "صفحه‌های سایت",
    description: "برگه‌های ثابت سایت و وضعیت انتشار.",
    eligibility: { permissions: [PERMISSIONS.cmsView] },
    intro: {
      title: "صفحه‌های ثابت",
      body:
        "صفحه‌ها برگه‌های ثابت سایت‌اند (درباره ما، تماس، قوانین). نوشته‌های زمان‌دار در «نوشته‌ها» هستند.",
    },
    details: [
      {
        title: "پیش‌نویس و انتشار",
        body:
          "هر صفحه پیش‌نویس یا منتشرشده است؛ انتشار فوراً روی سایت زنده دیده می‌شود. پیش‌نمایش پیش از انتشار، متن و چیدمان را نشان می‌دهد.",
      },
    ],
    nextBody: "برای تغییر محتوا از ویرایشگر خود صفحه استفاده کنید. تور چیزی را منتشر یا حذف نمی‌کند.",
  }),
  websitePageTour({
    id: "websites.cms.posts.page",
    pageKey: "page:/websites/cms/posts",
    title: "نوشته‌های سایت",
    description: "مطالب وبلاگ و اخبار با تاریخ و دسته.",
    eligibility: { permissions: [PERMISSIONS.cmsView] },
    intro: {
      title: "نوشته‌ها",
      body: "نوشته‌ها مطالب وبلاگ و اخبار سایت‌اند و برخلاف صفحه‌ها تاریخ و دسته دارند.",
    },
    details: [
      {
        title: "پیش‌نویس و زمان انتشار",
        body:
          "نوشته هم پیش‌نویس و منتشرشده دارد. زمان‌بندی انتشار و دسته‌ها روی فهرست عمومی سایت اثر می‌گذارند.",
      },
    ],
    nextBody: "انتشار و حذف نوشته عملیات واقعی‌اند. برای بازبینی متن از پیش‌نمایش استفاده کنید.",
  }),
  websitePageTour({
    id: "websites.cms.media.page",
    pageKey: "page:/websites/cms/media",
    title: "رسانه‌های سایت",
    description: "تصاویر و فایل‌های مشترک صفحه‌ها و نوشته‌ها.",
    eligibility: { permissions: [PERMISSIONS.cmsView] },
    intro: {
      title: "کتابخانهٔ رسانه",
      body:
        "کتابخانهٔ رسانه، تصاویر و فایل‌های سایت را نگه می‌دارد و صفحه‌ها و نوشته‌ها از همین‌جا به آن‌ها ارجاع می‌دهند.",
    },
    details: [
      {
        title: "جایگزینی و حذف",
        body:
          "حذف یا جایگزینی یک فایل روی هر صفحه‌ای که به آن ارجاع داده اثر می‌گذارد. اندازه و نوع فایل را قبل از بارگذاری بررسی کنید.",
      },
    ],
    nextBody: "بارگذاری و حذف فایل واقعی است. این تور فقط کتابخانه را معرفی می‌کند.",
  }),
  websitePageTour({
    id: "websites.cms.products.page",
    pageKey: "page:/websites/cms/products",
    title: "محصولات سایت",
    description: "کالاهای فروشگاه اینترنتی و همگام‌سازی با صندوق.",
    eligibility: { permissions: [PERMISSIONS.cmsView] },
    intro: {
      title: "کالاهای فروشگاه سایت",
      body:
        "محصولات سایت، کالاهای فروشگاه اینترنتی‌اند. قیمت و موجودی می‌تواند از صندوق همگام شود، اما خود محصول جای خودش را دارد.",
    },
    details: [
      {
        title: "جهت همگام‌سازی",
        body:
          "تنظیمات همگام‌سازی در «تنظیمات سایت» است و یک‌طرفه از صندوق به سایت کار می‌کند. تغییر محصول در سایت، صندوق را عوض نمی‌کند.",
      },
    ],
    nextBody: "انتشار یا حذف محصول روی فروشگاه زنده اثر دارد. پیش از تغییر قیمت، همگام‌سازی را بررسی کنید.",
  }),
  websitePageTour({
    id: "websites.cms.orders.page",
    pageKey: "page:/websites/cms/orders",
    title: "سفارش‌های سایت",
    description: "سفارش‌های آنلاین فروشگاه و خطاهای تحویل.",
    eligibility: { permissions: [PERMISSIONS.cmsView] },
    intro: {
      title: "سفارش آنلاین",
      body:
        "سفارش‌های آنلاین فروشگاه سایت اینجا دیده می‌شوند. تغییر وضعیت یا برگشت وجه یک عمل واقعی است.",
    },
    details: [
      {
        title: "خطاهای تحویل",
        body:
          "اگر سفارش کافه‌ای در تحویل ناموفق باشد، بخش خطاهای تحویل بالای فهرست نشان داده می‌شود تا پیگیری شود.",
      },
    ],
    nextBody: "وضعیت سفارش را از مسیر خودش تغییر دهید. تور هیچ سفارشی را تأیید یا لغو نمی‌کند.",
  }),
  websitePageTour({
    id: "websites.cms.design.page",
    pageKey: "page:/websites/cms/design",
    title: "طراحی و پوسته",
    description: "پوسته، استقرار و ظاهر سایت.",
    eligibility: { permissions: [PERMISSIONS.cmsView] },
    intro: {
      title: "ظاهر سایت",
      body:
        "طراحی و پوسته ظاهر سایت را تعیین می‌کند: قالب، رنگ‌ها و چیدمان. تغییر پوسته روی همهٔ صفحه‌ها اثر دارد.",
    },
    details: [
      {
        title: "استقرار",
        body:
          "ذخیرهٔ طراحی با استقرار همراه است؛ پیش از استقرار از پیش‌نمایش استفاده کنید. بازگشت به نسخهٔ قبلی از مسیر خودش انجام می‌شود.",
      },
    ],
    nextBody: "استقرار پوسته یک عمل واقعی و عمومی است. این تور چیزی را تغییر نمی‌دهد.",
  }),
  websitePageTour({
    id: "websites.cms.domain.page",
    pageKey: "page:/websites/cms/domain",
    title: "دامنه و DNS",
    description: "دامنه، رکوردها و CDN سایت.",
    eligibility: { permissions: [PERMISSIONS.cmsView] },
    intro: {
      title: "آدرس عمومی سایت",
      body:
        "اینجا دامنه، رکوردهای DNS و CDN سایت دیده می‌شوند. دامنه همان آدرسی است که مشتری در مرورگر می‌زند.",
    },
    details: [
      {
        title: "تغییر رکورد",
        body:
          "تغییر رکورد DNS یا CDN می‌تواند سایت را از دسترس خارج کند. مقدارها را از ارائه‌دهنده بگیرید و پس از تغییر، انتشار DNS را بررسی کنید.",
      },
    ],
    nextBody: "ثبت یا تغییر دامنه عمل واقعی است و ممکن است هزینه داشته باشد. تور فقط وضعیت را توضیح می‌دهد.",
  }),
  websitePageTour({
    id: "websites.cms.settings.page",
    pageKey: "page:/websites/cms/settings",
    title: "تنظیمات همگام‌سازی",
    description: "چه چیزی از صندوق به سایت می‌رود.",
    eligibility: { permissions: [PERMISSIONS.cmsView] },
    intro: {
      title: "همگام‌سازی یک‌طرفه",
      body:
        "این تنظیمات می‌گوید چه چیزی از صندوق به سایت برود: قیمت و موجودی، یک‌طرفه. خود اتصال سایت در «اتصال‌های فنی» است.",
    },
    details: [
      {
        title: "دامنهٔ همگام‌سازی",
        body:
          "فقط محصولات علامت‌خورده همگام می‌شوند. ارسال قیمت یا موجودی را می‌توان جدا خاموش کرد تا عمداً دستی بماند.",
      },
    ],
    nextBody: "ذخیرهٔ تنظیمات روی ارسال‌های بعدی اثر دارد. صف ارسال را پس از تغییر بررسی کنید.",
  }),
  websitePageTour({
    id: "websites.cms.billing.page",
    pageKey: "page:/websites/cms/billing",
    title: "اشتراک و صورت‌حساب",
    description: "طرح، پایان دوره، هزینه‌ها و اعتبار.",
    eligibility: { permissions: [PERMISSIONS.cmsView] },
    intro: {
      title: "هزینهٔ سایت",
      body:
        "اشتراک سایت، دامنه و تمدید از اعتبار پلتفرم پرداخت می‌شوند. سایت‌ساز کار سایت را انجام می‌دهد و صورت‌حساب اینجاست.",
    },
    details: [
      {
        title: "خواندن صورت‌حساب",
        body:
          "طرح، پایان دورهٔ جاری، هزینه‌های ثبت‌شده و موجودی اعتبار را ببینید. تمدید یا تغییر طرح یک عمل مالی واقعی است.",
      },
    ],
    nextBody: "پرداخت و تمدید از مسیر خودش با تأیید انجام می‌شود. این تور چیزی خریداری نمی‌کند.",
  }),
  websitePageTour({
    id: "websites.wp.products.page",
    pageKey: "page:/websites/wp/products",
    title: "محصولات وردپرس",
    description: "کاتالوگ همگام‌شدهٔ فروشگاه ووکامرس.",
    eligibility: { permissions: [PERMISSIONS.woocommerceView], features: ["integrations"] },
    intro: {
      title: "کاتالوگ فروشگاه",
      body:
        "این فهرست، محصولات همگام‌شدهٔ فروشگاه وردپرس/ووکامرس است. ویرایش اینجا روی فروشگاه زنده اثر دارد.",
    },
    details: [
      {
        title: "همگام‌سازی و صف",
        body:
          "همگام‌سازی از دکمهٔ خودش انجام می‌شود و صف عملیات نتیجه را نشان می‌دهد. اگر اتصال قطع باشد، تغییرات در صف می‌مانند.",
      },
    ],
    nextBody: "حذف یا تغییر قیمت یک عمل واقعی روی فروشگاه است. تور چیزی را تغییر نمی‌دهد.",
  }),
  websitePageTour({
    id: "websites.wp.orders.page",
    pageKey: "page:/websites/wp/orders",
    title: "سفارش‌های وردپرس",
    description: "سفارش‌های فروشگاه و صف عملیات.",
    eligibility: { permissions: [PERMISSIONS.woocommerceView], features: ["integrations"] },
    intro: {
      title: "سفارش‌های فروشگاه",
      body:
        "سفارش‌های فروشگاه وردپرس اینجا خوانده می‌شوند. تغییر وضعیت و برگشت وجه از طریق صف عملیات به فروشگاه می‌رود.",
    },
    details: [
      {
        title: "نتیجهٔ عملیات",
        body:
          "اگر نتیجهٔ یک عملیات برنگردد، در «صف و رویدادها» دیده می‌شود. وضعیت محلی تا تأیید فروشگاه قطعی نیست.",
      },
    ],
    nextBody: "تغییر وضعیت سفارش و برگشت وجه واقعی است. این تور فقط مسیر را توضیح می‌دهد.",
  }),
  websitePageTour({
    id: "websites.wp.customers.page",
    pageKey: "page:/websites/wp/customers",
    title: "مشتریان وردپرس",
    description: "مشتریان فروشگاه و اتصال آن‌ها به CRM.",
    eligibility: { permissions: [PERMISSIONS.woocommerceView], features: ["integrations"] },
    intro: {
      title: "مشتری فروشگاه",
      body:
        "مشتریان فروشگاه وردپرس به پروندهٔ مشتریان CRM وصل می‌شوند تا خرید آنلاین و سابقهٔ داخلی یک نفر کنار هم دیده شود.",
    },
    details: [
      {
        title: "اتصال و رضایت",
        body:
          "اتصال مشتری، رضایت بازاریابی نمی‌سازد. برای تغییر رضایت از پروندهٔ همان مشتری در CRM استفاده کنید.",
      },
    ],
    nextBody: "همگام‌سازی مشتریان از دکمهٔ خودش انجام می‌شود؛ این تور چیزی را تغییر نمی‌دهد.",
  }),
  websitePageTour({
    id: "websites.wp.taxonomies.page",
    pageKey: "page:/websites/wp/taxonomies",
    title: "دسته‌ها و ویژگی‌ها",
    description: "درخت دسته‌بندی، برچسب و ویژگی‌های فروشگاه.",
    eligibility: { permissions: [PERMISSIONS.woocommerceView], features: ["integrations"] },
    intro: {
      title: "ساختار کاتالوگ",
      body:
        "دسته‌ها، برچسب‌ها و ویژگی‌ها ساختار کاتالوگ فروشگاه را می‌سازند و محصولات به آن‌ها وصل می‌شوند.",
    },
    details: [
      {
        title: "اثر تغییر ساختار",
        body:
          "حذف یک دسته می‌تواند محصولات را از فهرست دسته بیرون بیاورد. پیش از تغییر ساختار، محصولات وابسته را بررسی کنید.",
      },
    ],
    nextBody: "تغییر دسته یا ویژگی روی فروشگاه زنده اثر دارد. تور چیزی را حذف نمی‌کند.",
  }),
  websitePageTour({
    id: "websites.wp.content.page",
    pageKey: "page:/websites/wp/content",
    title: "محتوای وردپرس",
    description: "نوشته‌ها و برگه‌های وردپرس.",
    eligibility: { permissions: [PERMISSIONS.woocommerceView], features: ["integrations"] },
    intro: {
      title: "محتوا",
      body:
        "نوشته‌ها و برگه‌های وردپرس اینجا دیده و ویرایش می‌شوند. ویرایش با اجازهٔ مدیریت محتوا انجام می‌شود.",
    },
    details: [
      {
        title: "پیش‌نویس و انتشار",
        body:
          "پیش‌نویس تا انتشار روی سایت دیده نمی‌شود. پیش از انتشار، متن و رسانه‌های پیوست را بررسی کنید.",
      },
    ],
    nextBody: "ایجاد یا انتشار محتوا واقعی است. این تور فقط مسیر را نشان می‌دهد.",
  }),
  websitePageTour({
    id: "websites.wp.media.page",
    pageKey: "page:/websites/wp/media",
    title: "رسانه‌های وردپرس",
    description: "کتابخانهٔ تصاویر و فایل‌های فروشگاه.",
    eligibility: { permissions: [PERMISSIONS.woocommerceView], features: ["integrations"] },
    intro: {
      title: "کتابخانهٔ فروشگاه",
      body:
        "کتابخانهٔ رسانهٔ فروشگاه، تصاویر و فایل‌های پیوست را نگه می‌دارد. بارگذاری و حذف با اجازهٔ مدیریت انجام می‌شود.",
    },
    details: [
      {
        title: "رسانهٔ کانونیک",
        body:
          "اگر رسانهٔ کانونیک هم فعال باشد، می‌توانید فایل مشترک پلتفرم را به‌جای بارگذاری دوباره انتخاب کنید.",
      },
    ],
    nextBody: "حذف یک فایل روی محصول یا نوشته‌ای که به آن ارجاع دارد اثر می‌گذارد. تور چیزی را حذف نمی‌کند.",
  }),
  websitePageTour({
    id: "websites.wp.queue.page",
    pageKey: "page:/websites/wp/queue",
    title: "صف و رویدادهای وردپرس",
    description: "عملیات در انتظار ارسال و رویدادهای ناموفق.",
    eligibility: { permissions: [PERMISSIONS.woocommerceView], features: ["integrations"] },
    intro: {
      title: "صف عملیات",
      body:
        "صف عملیات خروجی و رویدادهای ورودی ناموفق را نشان می‌دهد: چه چیزی در انتظار ارسال است و چه چیزی برنگشته.",
    },
    details: [
      {
        title: "تلاش دوباره",
        body:
          "تلاش دوباره و ارسال فوری با اجازهٔ همگام‌سازی انجام می‌شود. پیش از تلاش دوباره، علت خطا و وضعیت اتصال را ببینید.",
      },
    ],
    nextBody: "پاک‌کردن صف یا تلاش دوباره یک عمل واقعی است. این تور فقط وضعیت را توضیح می‌دهد.",
  }),
  accountingPageTour({
    id: "accounting.reports.page",
    pageKey: "page:/accounting/reports",
    title: "گزارش‌ها",
    description: "کتابخانهٔ گزارش‌های آماده و گزارش‌ساز.",
    eligibility: { permissions: [PERMISSIONS.reportsView] },
    intro: {
      title: "کتابخانهٔ گزارش",
      body:
        "گزارش‌ها کتابخانهٔ گزارش‌های آماده است: فروش، انبار، حسابداری و کارکنان، به‌همراه گزارش‌ساز. هر گزارش از دادهٔ همین کسب‌وکار و در بازهٔ انتخابی ساخته می‌شود.",
    },
    details: [
      {
        title: "آماده یا سفارشی",
        body:
          "اگر سؤال تکرارشونده دارید از گزارش آماده شروع کنید؛ اگر ستون و فیلتر سفارشی می‌خواهید گزارش‌ساز را باز کنید.",
      },
    ],
    nextBody: "خروجی و ارسال گزارش با اجازهٔ خروجی انجام می‌شود. این تور چیزی صادر نمی‌کند.",
  }),
  accountingPageTour({
    id: "accounting.reservations.page",
    pageKey: "page:/accounting/reservations",
    title: "رزرو میز",
    description: "رزروهای آینده و وضعیت هر رزرو.",
    eligibility: { permissions: [PERMISSIONS.reservationsView] },
    intro: {
      title: "رزرو، پیش از فروش",
      body:
        "رزرو میز برای زمانی در آینده است؛ با ورود مهمان به میز، فروش از مسیر سفارش انجام می‌شود.",
    },
    details: [
      {
        title: "ثبت و لغو",
        body:
          "ثبت رزرو با اجازهٔ مدیریت رزرو انجام می‌شود. برای تغییر یا لغو، وضعیت همان رزرو را از مسیر خودش عوض کنید.",
      },
    ],
    nextBody: "این تور رزروی نمی‌سازد و چیزی را لغو نمی‌کند.",
  }),
  accountingPageTour({
    id: "accounting.delivery.page",
    pageKey: "page:/accounting/delivery",
    title: "ارسال و پیک",
    description: "تخصیص سفارش به پیک و پیگیری تحویل.",
    eligibility: { permissions: [PERMISSIONS.deliveryManage] },
    intro: {
      title: "تحویل سفارش",
      body:
        "این صفحه سفارش‌های ارسالی را به پیک‌ها تخصیص می‌دهد و وضعیت تحویل را پیگیری می‌کند.",
    },
    details: [
      {
        title: "پیک و پیکربندی",
        body:
          "فهرست پیک‌ها و تنظیمات ارسال با اجازهٔ پیکربندی مدیریت می‌شوند. تغییر وضعیت تحویل روی سفارش و مشتری اثر دارد.",
      },
    ],
    nextBody: "تخصیص یا بستن تحویل یک عمل واقعی است. این تور چیزی را تغییر نمی‌دهد.",
  }),
  accountingPageTour({
    id: "accounting.floor.page",
    pageKey: "page:/accounting/floor",
    title: "نقشهٔ میزها",
    description: "وضعیت میزها و سفارش هر میز.",
    eligibility: { permissions: [PERMISSIONS.tablesManage] },
    intro: {
      title: "سالن",
      body:
        "نقشهٔ میزها وضعیت اشغال و سفارش هر میز را نشان می‌دهد. این صفحه برای کار روزانهٔ سالن است.",
    },
    details: [
      {
        title: "چیدمان و ویرایش",
        body:
          "ویرایش ساختاری چیدمان با اجازهٔ ویرایش میزها انجام می‌شود؛ جابه‌جایی میز روی سفارش‌های باز اثر دارد.",
      },
    ],
    nextBody: "این تور میزی را باز یا جابه‌جا نمی‌کند.",
  }),
  accountingPageTour({
    id: "accounting.kitchen.page",
    pageKey: "page:/accounting/kitchen",
    title: "صفحهٔ آشپزخانه",
    description: "سفارش‌های در جریان آماده‌سازی.",
    eligibility: { permissions: [PERMISSIONS.kitchenView] },
    intro: {
      title: "آشپزخانه",
      body:
        "صفحهٔ آشپزخانه سفارش‌های در جریان را برای آماده‌سازی نشان می‌دهد و با سالن هماهنگ است.",
    },
    details: [
      {
        title: "وضعیت آماده‌سازی",
        body:
          "تغییر وضعیت هر آیتم، آماده‌شدن آن را به سالن اعلام می‌کند. این صفحه مالی نیست و سندی نمی‌سازد.",
      },
    ],
    nextBody: "این تور وضعیت هیچ سفارشی را عوض نمی‌کند.",
  }),
  accountingPageTour({
    id: "accounting.waiter.page",
    pageKey: "page:/accounting/waiter",
    title: "میزهای من",
    description: "نمای خدمه از میزها و سفارش‌های خودشان.",
    eligibility: {
      anyOf: [
        { permissions: [PERMISSIONS.ordersCreate] },
        { permissions: [PERMISSIONS.tablesManage] },
        { permissions: [PERMISSIONS.ordersView] },
      ],
    },
    intro: {
      title: "نمای خدمه",
      body:
        "«میزهای من» نمای خدمه از میزهای خودشان است؛ هر نفر فقط میزهایی را می‌بیند که به او سپرده شده‌اند.",
    },
    details: [
      {
        title: "سفارش و وضعیت میز",
        body:
          "ثبت سفارش از همین‌جا یا صفحهٔ فروش انجام می‌شود؛ تغییر وضعیت میز با همان دسترسی سفارش و میز کنترل می‌شود.",
      },
    ],
    nextBody: "این تور سفارشی ثبت یا میزی را آزاد نمی‌کند.",
  }),
  accountingPageTour({
    id: "accounting.jewelry.page",
    pageKey: "page:/accounting/jewelry",
    title: "طلا و جواهر",
    description: "کالای وزنی، نرخ روز، امانت و فروش قطعه.",
    eligibility: {
      permissions: [PERMISSIONS.inventoryView],
      industries: ["jewelry"],
    },
    intro: {
      title: "کالای وزنی",
      body:
        "این بخش کالاهای وزنی، نرخ روز طلا، امانت‌گذاران و فروش قطعات را کنار هم نگه می‌دارد.",
    },
    details: [
      {
        title: "نرخ و مالکیت",
        body:
          "قیمت قطعه از وزن و نرخ روز ساخته می‌شود؛ نرخ را پیش از فروش بررسی کنید و مالکیت یا امانت قطعه را مشخص نگه دارید.",
      },
    ],
    nextBody: "فروش یا تغییر نرخ یک عمل واقعی است. این تور چیزی را نمی‌فروشد.",
  }),
  accountingPageTour({
    id: "accounting.watch.page",
    pageKey: "page:/accounting/watch",
    title: "ساعت",
    description: "مدل‌ها، سریال، گارانتی و تیکت تعمیر.",
    eligibility: {
      permissions: [PERMISSIONS.inventoryView],
      industries: ["watch"],
    },
    intro: {
      title: "دستگاه سریال‌دار",
      body:
        "این بخش مدل‌ها و دستگاه‌های سریال‌دار، فروش با گارانتی و تیکت‌های تعمیر را مدیریت می‌کند.",
    },
    details: [
      {
        title: "سریال و گارانتی",
        body:
          "سریال هر دستگاه یکتاست و گارانتی به همان دستگاه می‌چسبد. تیکت تعمیر از پروندهٔ همان دستگاه پیگیری می‌شود.",
      },
    ],
    nextBody: "ثبت سریال، فروش یا تیکت تعمیر واقعی است. این تور چیزی را تغییر نمی‌دهد.",
  }),
  accountingPageTour({
    id: "accounting.cosmetics.page",
    pageKey: "page:/accounting/cosmetics",
    title: "آرایشی و بهداشتی",
    description: "بچ، انقضا، برند و ماتریس تنوع‌ها.",
    eligibility: {
      permissions: [PERMISSIONS.inventoryView],
      industries: ["cosmetics"],
    },
    intro: {
      title: "بچ و انقضا",
      body:
        "این بخش بچ و انقضای کالا، برندها و ماتریس تنوع‌ها را نگه می‌دارد؛ گزارش‌های صنف در «گزارش‌های آماده» خوانده می‌شوند.",
    },
    details: [
      {
        title: "بچ معتبر",
        body:
          "هر بچ تاریخ انقضای خودش را دارد و فروش باید از بچ معتبر انجام شود. بچ منقضی نباید وارد فروش شود.",
      },
    ],
    nextBody: "این تور موجودی یا تاریخ انقضا را تغییر نمی‌دهد.",
  }),
  accountingPageTour({
    id: "accounting.ledger.page",
    pageKey: "page:/accounting/ledger",
    title: "فضای کار حسابداری",
    description: "فهرست همهٔ ابزارهای دفترداری.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    intro: {
      title: "یک جا برای همهٔ ابزارها",
      body:
        "فضای کار حسابداری همهٔ ابزارهای دفترداری را فهرست می‌کند: دفتر و اسناد، دریافتنی و پرداختنی، وجوه و هزینه، دوره، مالیات و حقوق.",
    },
    details: [
      {
        title: "انتخاب ابزار",
        body:
          "هر ابزار همان صفحهٔ خودش را باز می‌کند. این فهرست فقط راهنماست و خودش چیزی ثبت نمی‌کند.",
      },
    ],
    nextBody: "برای شروع، از «دفتر و اسناد» یا «دریافتنی و پرداختنی» استفاده کنید.",
  }),
  accountingPageTour({
    id: "accounting.manual.page",
    pageKey: "page:/accounting/manual",
    title: "سند دستی",
    description: "ثبت دوطرفه با پیش‌نویس و تأیید.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    intro: {
      title: "سند دوطرفه",
      body:
        "سند دستی برای ثبت رویدادی است که فروش، خرید یا هزینه خودکار نمی‌سازد. پیش‌نویس را می‌بینید و پس از تأیید وارد دفتر می‌شود.",
    },
    details: [
      {
        title: "توازن و اصلاح",
        body:
          "جمع بدهکار و بستانکار باید برابر باشد. سند تأییدشده ویرایش نمی‌شود؛ اصلاح با سند برگشت انجام می‌گیرد تا سابقه بماند.",
      },
    ],
    nextBody: "ثبت سند یک عمل مالی واقعی است و در تور انجام نمی‌شود.",
  }),
  accountingPageTour({
    id: "accounting.directory.page",
    pageKey: "page:/accounting/directory",
    title: "اشخاص",
    description: "یک پرونده برای هر طرف‌حساب، با چند نقش.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    intro: {
      title: "یک فهرست، همهٔ نقش‌ها",
      body:
        "این فهرست همهٔ طرف‌حساب‌ها را نگه می‌دارد: مشتری، تأمین‌کننده، فروشنده و کارمند. یک نفر می‌تواند چند نقش داشته باشد.",
    },
    details: [
      {
        title: "نقش اصلی و فیلترها",
        body:
          "نقش اصلی پیشوند کد حسابداری را تعیین می‌کند و نقش‌های دیگر در همان پرونده می‌مانند. برای دیدن فقط یک نقش از فیلترهای بالای فهرست استفاده کنید.",
      },
    ],
    nextBody: "افزودن یا تغییر شخص از فرم خودش با تأیید انجام می‌شود؛ تور چیزی را تغییر نمی‌دهد.",
  }),
  accountingPageTour({
    id: "accounting.financial-accounts.page",
    pageKey: "page:/accounting/financial-accounts",
    title: "حساب‌های مالی",
    description: "بانک، صندوق، تنخواه و کارت‌خوان.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    intro: {
      title: "ظرف پول کسب‌وکار",
      body:
        "هر حساب مالی یک ظرف پول است: بانک، صندوق، تنخواه یا کارت‌خوان. هر حساب به یک سرفصل دفتر کل وصل است و مانده‌اش از دفتر خوانده می‌شود.",
    },
    details: [
      {
        title: "اصلاح مانده",
        body:
          "مانده را دستی ویرایش نکنید؛ با انتقال، دریافت/پرداخت یا تطبیق بانکی اصلاح کنید تا دفتر و حساب هم‌خوان بمانند.",
      },
    ],
    nextBody: "ساخت حساب یا تغییر اتصال آن واقعی است. این تور چیزی را تغییر نمی‌دهد.",
  }),
  accountingPageTour({
    id: "accounting.transfers.page",
    pageKey: "page:/accounting/transfers",
    title: "انتقال وجه",
    description: "جابه‌جایی پول بین حساب‌های مالی.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    intro: {
      title: "انتقال بین حساب‌ها",
      body:
        "انتقال وجه پول را بین حساب‌های مالی کسب‌وکار جابه‌جا می‌کند و سند دوطرفهٔ خودکار می‌سازد. پیش از ثبت، پیش‌نمایش سند را ببینید.",
    },
    details: [
      {
        title: "بدون ویرایش",
        body:
          "انتقال ویرایش یا حذف نمی‌شود؛ برای اصلاح، سند را برگشت دهید و انتقال درست را ثبت کنید.",
      },
    ],
    nextBody: "ثبت انتقال یک عمل مالی واقعی است. این تور انتقالی ثبت نمی‌کند.",
  }),
  accountingPageTour({
    id: "accounting.cheques.page",
    pageKey: "page:/accounting/cheques",
    title: "چک‌ها",
    description: "چک دریافتی و پرداختی و وضعیت هر کدام.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    intro: {
      title: "چک، سند تعهد",
      body:
        "چک‌های دریافتی و پرداختی اینجا با سررسید و وضعیت نگه داشته می‌شوند: در جریان، وصول، برگشتی یا خرج‌شده.",
    },
    details: [
      {
        title: "تغییر وضعیت",
        body:
          "وضعیت چک با رویداد واقعی بانک عوض می‌شود. چک برگشتی از مسیر خودش اصلاح می‌شود تا سابقهٔ تعهد بماند.",
      },
    ],
    nextBody: "ثبت یا وصول چک واقعی است. این تور وضعیت هیچ چکی را عوض نمی‌کند.",
  }),
  accountingPageTour({
    id: "accounting.vat.page",
    pageKey: "page:/accounting/vat",
    title: "گزارش مالیات",
    description: "مالیات ارزش افزودهٔ فروش و خرید در هر دوره.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    intro: {
      title: "مالیات دوره",
      body:
        "این گزارش مالیات بر ارزش افزودهٔ فروش و خرید را در دورهٔ انتخابی جمع می‌کند.",
    },
    details: [
      {
        title: "بازه و نرخ",
        body:
          "نرخ و دوره را بررسی کنید؛ گزارش فقط می‌خواند و اظهارنامه نمی‌فرستد. ارسال یا اصلاح اظهارنامه از مسیر خودش انجام می‌شود.",
      },
    ],
    nextBody: "این تور چیزی ارسال یا اصلاح نمی‌کند.",
  }),
  accountingPageTour({
    id: "accounting.financial-reports.page",
    pageKey: "page:/accounting/financial-reports",
    title: "گزارش‌های مالی",
    description: "صورت‌های مالی و گزارش‌های حسابداری.",
    eligibility: { permissions: [PERMISSIONS.ledgerView, PERMISSIONS.reportsView] },
    intro: {
      title: "صورت‌های مالی",
      body:
        "گزارش‌های مالی از دفتر همان دوره خوانده می‌شوند و راه رسیدن به گزارش‌های کسب‌وکار را نشان می‌دهند.",
    },
    details: [
      {
        title: "دورهٔ باز یا بسته",
        body:
          "اگر دوره بسته نشده باشد، اعداد موقت‌اند. برای عدد نهایی، ابتدا وضعیت دوره را در «سال‌ها و دوره‌های مالی» بررسی کنید.",
      },
    ],
    nextBody: "این تور چیزی صادر یا دوره‌ای را نمی‌بندد.",
  }),
  accountingPageTour({
    id: "accounting.growth.page",
    pageKey: "page:/accounting/growth",
    title: "رشد در حسابداری",
    description: "اثر مالی وفاداری، کمپین و پورسانت در دفتر.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    intro: {
      title: "پل رشد و دفتر",
      body:
        "این صفحه اثر مالی باشگاه مشتریان، کمپین‌ها و پورسانت را در دفتر نشان می‌دهد.",
    },
    details: [
      {
        title: "کجا مدیریت می‌شود",
        body:
          "خود کمپین، امتیاز و قانون پورسانت در برنامهٔ رشد مدیریت می‌شوند. اینجا فقط اثر مالی آن‌ها در حسابداری خوانده می‌شود.",
      },
    ],
    nextBody: "این تور کمپینی نمی‌سازد و در دفتر چیزی ثبت نمی‌کند.",
  }),
  accountingPageTour({
    id: "accounting.settings.page",
    pageKey: "page:/accounting/settings",
    title: "تنظیمات حسابداری",
    description: "سرفصل‌ها، دوره‌ها و قواعد سندزنی.",
    eligibility: { permissions: [PERMISSIONS.ledgerView] },
    intro: {
      title: "تنظیمات همین برنامه",
      body:
        "این تنظیمات مخصوص حسابداری است: سرفصل حساب‌ها، دوره‌های مالی و قواعد سندزنی. تنظیمات کسب‌وکار و پلتفرم در /settings است.",
    },
    details: [
      {
        title: "اثر قواعد",
        body:
          "تغییر قواعد سندزنی روی ثبت‌های آینده اثر دارد. سرفصل‌های سیستمی محافظت می‌شوند و حساب دارای سند بایگانی می‌شود، نه حذف.",
      },
    ],
    nextBody: "این تور تنظیمی را تغییر نمی‌دهد.",
  }),
  {
    id: "workspace.projects.page",
    version: 1,
    pageKey: "page:/workspace/projects",
    route: "/workspace/projects",
    title: "پروندهٔ پروژه",
    description: "کارها، زمان و هزینهٔ پروژه در یک جا.",
    eligibility: { permissions: [PERMISSIONS.workspaceView] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "پروندهٔ پروژه",
        body:
          "پروندهٔ پروژه کارها، زمان و هزینهٔ یک پروژه را در یک جا نگه می‌دارد و به مشتری و اسناد مالی وصل می‌شود.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سرصفحهٔ پروژه",
        body:
          "عنوان و توضیح صفحه بالای آن است؛ دکمهٔ «آموزش» هم در همین نوار قرار دارد.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.appSectionNav,
        title: "منوی میز کار من",
        body:
          "این منو بخش‌های میز کار را نگه می‌دارد: پروژه‌ها، وظایف، اسناد و قراردادها. فقط بخش‌های مجاز نقش شما نمایش داده می‌شود.",
      },
      {
        id: "detail-1",
        kind: "explain",
        title: "دسترسی پروژه",
        body:
          "عضویت و نقش داخل پروژه دسترسی را محدودتر می‌کند. اسناد مالی پروژه از مسیر حسابداری ثبت می‌شوند، نه از این پرونده.",
      },
      {
        id: "next",
        kind: "explain",
        title: "قدم بعدی",
        body: "این تور پروژه‌ای نمی‌سازد و چیزی را تغییر نمی‌دهد.",
      },
    ],
  },
  {
    id: "settings.connections.page",
    version: 1,
    pageKey: "page:/settings/connections",
    route: "/settings/connections",
    title: "اتصال‌های فنی",
    description: "دسکتاپ، وردپرس، سایت، هلو و دسترسی توسعه‌دهنده.",
    eligibility: {},
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "یک هاب برای اتصال‌ها",
        body:
          "اتصال‌های فنی همهٔ پیوندهای بیرونی کسب‌وکار را یک‌جا نگه می‌دارد: نصب دسکتاپ، وردپرس/ووکامرس، سایت بیزامیز، هلو، همگام‌سازی سرور و دسترسی توسعه‌دهنده.",
      },
      {
        id: "header",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageHeader,
        title: "سرصفحهٔ اتصال‌ها",
        body:
          "عنوان و توضیح صفحه بالای آن است. وضعیت کلی اتصال‌ها و تب فعال از همین نوار دیده می‌شود.",
      },
      {
        id: "menu",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.pageSectionNav,
        title: "منوی تنظیمات",
        body:
          "تنظیمات به بخش‌های جدا تقسیم شده است. این منو همان بخش‌ها را جابه‌جا می‌کند و فقط موارد مجاز نقش شما را نشان می‌دهد.",
      },
      {
        id: "detail-1",
        kind: "explain",
        title: "تب‌های جدا",
        body:
          "هر تب اجازه و قفل خودش را دارد و تب غیرمجاز برای نقش شما نمایش داده نمی‌شود. کلیدها و رمزها در تور نمایش داده نمی‌شوند.",
      },
      {
        id: "detail-2",
        kind: "explain",
        title: "قطع و تغییر",
        body:
          "قطع یا تغییر یک اتصال روی عملیات واقعی اثر می‌گذارد. فقط با هماهنگی و از مسیر تأییدشده انجامش دهید.",
      },
      {
        id: "next",
        kind: "explain",
        title: "قدم بعدی",
        body: "این تور هیچ اتصالی را وصل، قطع یا تغییر نمی‌دهد.",
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

/** The canonical routes a member may reach inside one tour, in step order. */
export function tourRoutes(tour: Pick<TourDefinition, "route" | "steps">): string[] {
  const routes = [tour.route];
  for (const step of tour.steps) {
    if (step.kind === "navigate" && step.navigateTo && !routes.includes(step.navigateTo)) {
      routes.push(step.navigateTo);
    }
  }
  return routes;
}

/**
 * The route a step is shown on: the tour's entry route, then the most recent
 * navigate target BEFORE this step. A `navigate` step belongs to the page it
 * is standing on (it is the hand-off), so the step after it is the first one
 * on the new route.
 */
export function tourStepRoute(
  tour: Pick<TourDefinition, "route" | "steps">,
  index: number,
): string {
  let route = tour.route;
  for (let i = 0; i < Math.min(index, tour.steps.length); i += 1) {
    const step = tour.steps[i];
    if (step.kind === "navigate" && step.navigateTo) route = step.navigateTo;
  }
  return route;
}

/** Index of the first step shown on `route`, at or after `from` (default 0). */
export function firstTourStepOnRoute(
  tour: Pick<TourDefinition, "route" | "steps">,
  route: string,
  from = 0,
): number {
  for (let i = Math.max(0, from); i < tour.steps.length; i += 1) {
    if (tourStepRoute(tour, i) === route) return i;
  }
  return -1;
}

export interface TourViewer {
  permissions: ReadonlySet<string>;
  industry: Industry | string | null;
  /**
   * Effective feature flags, read only when some tour on the page asks about
   * one (`tourFactsNeeded`). Absent means "not read": a tour that needs it
   * does not match, rather than guessing.
   */
  features?: Readonly<Record<string, boolean>>;
  /** Same laziness as `features`. */
  inventorySystem?: TourInventorySystem;
}

export function viewerMatchesEligibility(rule: TourEligibility, viewer: TourViewer): boolean {
  for (const permission of rule.permissions ?? []) {
    if (!viewer.permissions.has(permission)) return false;
  }
  for (const permission of rule.withoutPermissions ?? []) {
    if (viewer.permissions.has(permission)) return false;
  }
  const industries = rule.industries;
  if (industries && !(viewer.industry && (industries as readonly string[]).includes(viewer.industry))) {
    return false;
  }
  for (const key of rule.features ?? []) {
    if (!viewer.features || viewer.features[key] === false) return false;
  }
  for (const key of rule.withoutFeatures ?? []) {
    if (!viewer.features || viewer.features[key] !== false) return false;
  }
  if (rule.inventorySystem && viewer.inventorySystem !== rule.inventorySystem) return false;
  if (rule.anyOf && !rule.anyOf.some((alternative) => viewerMatchesEligibility(alternative, viewer))) {
    return false;
  }
  return true;
}

/**
 * Whether a member may be told this tour exists. The server calls it for the
 * lookup and again for every progress write, so a permission removed mid-tour
 * stops the writes, not just the button.
 */
export function isTourEligible(tour: TourDefinition, viewer: TourViewer): boolean {
  return viewerMatchesEligibility(tour.eligibility, viewer);
}

/**
 * The tour as THIS viewer sees it: `null` when they may not be told it exists
 * or none of its steps apply to them, otherwise the definition narrowed to the
 * steps they match. Everything the server derives from a tour — the summary's
 * step count, the playback, the progress rules — must start from this result,
 * so what a member is shown, what they are asked to finish and what the
 * percentage is computed over can never disagree.
 */
export function tourForViewer(tour: TourDefinition, viewer: TourViewer): TourDefinition | null {
  if (!isTourEligible(tour, viewer)) return null;
  const steps = tour.steps.filter((step) => !step.eligibility || viewerMatchesEligibility(step.eligibility, viewer));
  if (steps.length === 0) return null;
  return steps.length === tour.steps.length ? tour : { ...tour, steps };
}

/** Every tour on a page that this viewer may use, narrowed to their steps. */
export function toursForViewer(pageKey: string, viewer: TourViewer): TourDefinition[] {
  return toursForPage(pageKey).flatMap((tour) => {
    const visible = tourForViewer(tour, viewer);
    return visible ? [visible] : [];
  });
}

/** Which optional viewer facts these tours ask about, so the server reads only those. */
export function tourFactsNeeded(tours: readonly TourDefinition[]): {
  features: boolean;
  inventorySystem: boolean;
} {
  const needs = { features: false, inventorySystem: false };
  const scan = (rule: TourEligibility | undefined) => {
    if (!rule) return;
    if (rule.features?.length || rule.withoutFeatures?.length) needs.features = true;
    if (rule.inventorySystem) needs.inventorySystem = true;
    rule.anyOf?.forEach(scan);
  };
  for (const tour of tours) {
    scan(tour.eligibility);
    for (const step of tour.steps) scan(step.eligibility);
  }
  return needs;
}

/** Structural problems with a catalogue, as sentences. Empty means publishable. */
export function validateTours(tours: readonly TourDefinition[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const anchors = new Set<string>(Object.values(TOUR_ANCHORS));
  const registeredRoutes = new Set(KNOWLEDGE_PAGES.map((page) => page.route));
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
    for (const [index, step] of tour.steps.entries()) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(step.id)) problems.push(`${tour.id}/${step.id}: invalid step id`);
      if (stepIds.has(step.id)) problems.push(`${tour.id}/${step.id}: duplicate step id`);
      stepIds.add(step.id);
      if (step.kind === "spotlight" && (!step.anchor || !anchors.has(step.anchor))) {
        problems.push(`${tour.id}/${step.id}: spotlight step needs a registered anchor`);
      }
      if (step.kind === "explain" && step.anchor) {
        problems.push(`${tour.id}/${step.id}: explain step must not name an anchor`);
      }
      if (step.kind === "navigate") {
        if (!step.navigateTo || !registeredRoutes.has(step.navigateTo)) {
          problems.push(`${tour.id}/${step.id}: navigate step needs a registered destination route`);
        } else if (step.navigateTo === tourStepRoute(tour, index)) {
          problems.push(`${tour.id}/${step.id}: navigate step must move to another page`);
        } else if (tourStepRoute(tour, index + 1) !== step.navigateTo) {
          // `tourStepRoute` is the single definition of "where the next step
          // lives"; two navigate steps in a row would make it disagree with
          // the card the member sees.
          problems.push(`${tour.id}/${step.id}: a navigate step must be followed by a step on its destination`);
        }
        if (step.anchor) problems.push(`${tour.id}/${step.id}: navigate step must not name an anchor`);
        if (index === tour.steps.length - 1) {
          problems.push(`${tour.id}/${step.id}: a tour cannot end on a navigate step`);
        }
      } else if (step.navigateTo) {
        problems.push(`${tour.id}/${step.id}: only a navigate step may name a destination`);
      }
      if (step.kind === "action") {
        if (!isTourVerifier(step.verifier)) {
          problems.push(`${tour.id}/${step.id}: action step needs a registered verifier`);
        }
        if (step.anchor && !anchors.has(step.anchor)) {
          problems.push(`${tour.id}/${step.id}: action step points at an unregistered anchor`);
        }
      } else if (step.verifier) {
        problems.push(`${tour.id}/${step.id}: only an action step may name a verifier`);
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
  | { type: "reset" }
  /**
   * An `action` step completed. This one is raised by the SERVER after it has
   * checked evidence; the public progress route refuses it, so a client cannot
   * send it even though it appears in the union the pure rules understand.
   */
  | { type: "verified"; stepId: string };

export const TOUR_EVENT_TYPES = ["start", "step_seen", "pause", "complete", "reset"] as const;

/** The events the member-facing progress route accepts — never `verified`. */
export type TourClientEventType = (typeof TOUR_EVENT_TYPES)[number];

export type TourEventError =
  | "unknown_step"
  | "steps_unseen"
  /** A client tried to mark an `action` step as merely seen. */
  | "requires_evidence"
  /** A `verified` event named a step that asks for nothing real. */
  | "not_verifiable";

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

/**
 * Migrates stored progress to the current revision of `tour`: filters seen
 * ids that no longer exist, withdraws completion when a step has appeared
 * that the member never saw, and bumps `tourVersion` to `tour.version`.
 * Pure and idempotent — the DB half is `migrateTourProgressForBusiness`.
 */
export function migrateTourProgress(
  tour: TourDefinition,
  stored: StoredTourProgress | null,
): StoredTourProgress | null {
  const reconciled = reconcileTourProgress(tour, stored);
  if (!reconciled) return null;
  return { ...reconciled, tourVersion: tour.version };
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

  if (event.type === "step_seen" || event.type === "verified") {
    const step = tour.steps[index];
    // The two kinds are not interchangeable, in either direction: pressing
    // Next never proves an action, and a verified action is not something a
    // step without a verifier can claim.
    if (event.type === "step_seen" && step.kind === "action") {
      return { ok: false, error: "requires_evidence" };
    }
    if (event.type === "verified" && step.kind !== "action") {
      return { ok: false, error: "not_verifiable" };
    }
    if (!next.seenStepIds.includes(event.stepId)) next.seenStepIds = [...next.seenStepIds, event.stepId];
    if (!completed) {
      next.currentStepId = firstUnseenStep(tour, next.seenStepIds) ?? step.id;
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
