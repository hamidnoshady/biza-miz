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
import { INDUSTRIES, hasSellableCatalogue, type Industry } from "./industries";
import { hasCapability, hasModule, industryProfile } from "./industry-profile";
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
  posInvoiceMode: "pos.invoice-mode",
  posInvoiceItems: "pos.invoice-items",
  posInvoiceBarcode: "pos.invoice-barcode",
  posInvoiceLines: "pos.invoice-lines",
  posInvoiceCustomer: "pos.invoice-customer",
  posInvoicePayment: "pos.invoice-payment",
  posInvoiceSubmit: "pos.invoice-submit",
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
  // Cosmetics-only operations; one tab is mounted at a time.
  cosmeticsWorkspace: "cosmetics.workspace",
  cosmeticsExpiry: "cosmetics.expiry",
  cosmeticsBatchReceipt: "cosmetics.batch-receipt",
  cosmeticsBrand: "cosmetics.brand",
  cosmeticsMatrix: "cosmetics.matrix",
  cosmeticsProfile: "cosmetics.profile",
  cosmeticsTester: "cosmetics.tester",
  cosmeticsBarcodes: "cosmetics.barcodes",
  cosmeticsReports: "cosmetics.reports",
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
    ],
  },
  {
    id: "accounting.cosmetics.specialized",
    version: 1,
    pageKey: "page:/accounting/cosmetics",
    route: "/accounting/cosmetics",
    title: "آشنایی با آرایشی و بهداشتی",
    description: "بچ‌ها، انقضا، ثبت برند، ماتریس شید و حجم، اصالت کالا، تستر و لیبل را بشناسید.",
    eligibility: { permissions: [PERMISSIONS.inventoryView], industries: ["cosmetics"] },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "بخش آرایشی و بهداشتی",
        body: "این صفحه برای عملیات تخصصی آرایشی است؛ فهرست کالاها در «محصولات» و گزارش‌های فروش و انقضا در «گزارش‌های آماده» قرار دارند. تور صرفاً آموزشی است و هیچ بچ، تستر، موجودی یا سندی ثبت نمی‌کند.",
      },
      {
        id: "tabs",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.cosmeticsWorkspace,
        title: "دو زبانهٔ تخصصی",
        body: "از «بچ‌ها و انقضا» برای دریافت بچ و کنترل انقضا استفاده کنید. «برند و ماتریس» ابزارهای برند، تنوع، شناسنامهٔ کالا، تستر و بارکد را دارد. روی موبایل، ابتدا بخش را از فهرست باز کنید.",
      },
      {
        id: "expiry",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.cosmeticsExpiry,
        title: "هشدار بچ‌های نزدیک انقضا",
        body: "هر ردیف شماره بچ، تعداد و تاریخ انقضا دارد؛ هشدارها «منقضی»، «زیر ۳۰ روز» و «زیر ۹۰ روز» هستند. «حذف منقضی‌های کالا» همهٔ بچ‌های منقضی همان کالا را با اثر مالی خارج می‌کند؛ تور آن را نمی‌زند.",
        eligibility: { permissions: [PERMISSIONS.reportsView] },
      },
      {
        id: "batch-receipt",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.cosmeticsBatchReceipt,
        title: "ورود بچ",
        body: "تنوعِ بچ‌محور، شماره بچ، تاریخ انقضا، تعداد مثبت و بهای هر واحد را وارد می‌کنید. دریافت مجدد همان شماره بچ به موجودی آن اضافه می‌شود. ثبت در این فرم بر موجودی اثر واقعی دارد؛ تور آن را نمی‌زند.",
        eligibility: { permissions: [PERMISSIONS.inventoryAdjust] },
      },
      {
        id: "switch-tab",
        kind: "explain",
        title: "بخش دوم: برند و ماتریس",
        body: "برای دیدن کادرهای بخش دوم در جای واقعی‌شان، تور را با دکمهٔ بستن (×) موقتاً متوقف کنید، زبانهٔ «برند و ماتریس» را باز کنید و از «آموزش» تور را ادامه دهید. اگر اکنون «بعدی» را بزنید، بخش‌هایی که روی صفحه نیستند به‌صورت توضیحی نمایش داده می‌شوند.",
        eligibility: { permissions: [PERMISSIONS.inventoryAdjust] },
      },
      {
        id: "brand",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.cosmeticsBrand,
        title: "افزودن برند",
        body: "نام برند الزامی و کشور سازنده و خط تولید اختیاری‌اند. پس از «ثبت برند»، برند را از فرم شناسنامه به کالای موردنظر نسبت می‌دهید؛ ساخت برند به تنهایی محصولات قبلی را تغییر نمی‌دهد.",
        eligibility: { permissions: [PERMISSIONS.inventoryAdjust] },
      },
      {
        id: "matrix",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.cosmeticsMatrix,
        title: "ماتریس شید × حجم",
        body: "نام خانواده و محور اول با مقادیر جداشده با ویرگول را وارد کنید. محور دوم باید کاملاً خالی یا کامل باشد؛ مثلاً سه شید در دو حجم، شش تنوع می‌سازد. ساخت ماتریس موجودی و قیمت اولیه ثبت نمی‌کند.",
        eligibility: { permissions: [PERMISSIONS.inventoryAdjust] },
      },
      {
        id: "compliance",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.cosmeticsProfile,
        title: "برند و هویت قانونی کالا",
        body: "کالا را انتخاب کنید و برند، IRC، پروانه بهداشت، ثبت اصالت و نوع پوست یا مو را تکمیل کنید. این فرم فقط مشخصات داخلی را نگه می‌دارد؛ استعلام رسمی اصالت انجام نمی‌دهد.",
        eligibility: { permissions: [PERMISSIONS.inventoryAdjust] },
      },
      {
        id: "tester",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.cosmeticsTester,
        title: "تستر / نمونه",
        body: "«باز کردن تستر» یک واحد سالمِ قابل فروش را از موجودی کم و بهای آن را در حساب هزینهٔ ۵۱۶۰ ثبت می‌کند. این یک عملیات واقعی است؛ تور هیچ تستری باز نمی‌کند.",
        eligibility: { permissions: [PERMISSIONS.inventoryAdjust] },
      },
      {
        id: "barcodes",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.cosmeticsBarcodes,
        title: "بارکد و لیبل",
        body: "برای تنوع انتخابی بارکد فروشنده را ثبت کنید یا بارکد داخلی بسازید؛ سپس از فهرست کدها «چاپ لیبل» را بزنید. چاپ به رابط چاپ و چاپگر تنظیم‌شده نیاز دارد؛ تور چیزی چاپ نمی‌کند.",
        eligibility: { permissions: [PERMISSIONS.inventoryAdjust] },
      },
      {
        id: "reports",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.cosmeticsReports,
        title: "گزارش‌های آماده",
        body: "گزارش فروش تنوع‌ها، فروش به تفکیک برند و بچ‌های نزدیک انقضا در کتابخانهٔ گزارش‌ها هستند. گزارش‌های قدیمی دیگر زبانهٔ مستقل در این صفحه ندارند.",
        eligibility: { permissions: [PERMISSIONS.reportsView] },
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
    version: 1,
    pageKey: "page:/accounting/products/barcode-templates",
    route: "/accounting/products/barcode-templates",
    title: "آشنایی با الگوی بارکد وزنی",
    description: "با پیش‌شماره، واحد وزن و پیش‌نمایش برچسب بارکد وزنی آشنا شوید.",
    eligibility: { permissions: [PERMISSIONS.inventoryView], industries: PRODUCT_WORKSPACE_INDUSTRIES },
    steps: [
      {
        id: "welcome",
        kind: "explain",
        title: "الگوی بارکد وزنی",
        body:
          "برای کالاهایی که با ترازو وزن و بارکد می‌شوند، الگوی بارکد EAN-13 تعریف می‌کنید. این تور الگویی را ثبت یا حذف نمی‌کند.",
      },
      {
        id: "preview",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.barcodePreview,
        title: "پیش‌نمایش برچسب",
        body:
          "نمونهٔ زندهٔ الگوی فعال: پیش‌شماره (دو رقم)، کد کالا (پنج رقم)، مقدار وزن (پنج رقم) و رقم کنترل.",
      },
      {
        id: "templates",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.barcodeTemplates,
        title: "الگوهای ثبت‌شده",
        body:
          "هر الگو یک پیش‌شمارهٔ ثابت بین ۲۰ تا ۲۹ و یک واحد وزن دارد و هر پیش‌شماره فقط یک بار ثبت می‌شود. الگوی ثبت‌شده ویرایش نمی‌شود؛ اگر لازم شد آن را با دکمهٔ حذف بردارید و الگوی تازه بسازید.",
      },
      {
        id: "add",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.barcodeAdd,
        title: "افزودن الگو",
        body:
          "«افزودن الگو» یک کارت پیش‌نویس تازه می‌گذارد که پیش‌شماره و واحد وزنش را انتخاب می‌کنید. تا ثبت نکنید چیزی ذخیره نمی‌شود.",
      },
      {
        id: "save",
        kind: "spotlight",
        anchor: TOUR_ANCHORS.barcodeSave,
        title: "ثبت الگو",
        body:
          "«ثبت الگو» همهٔ پیش‌نویس‌ها را ذخیره می‌کند؛ اگر پیش‌شماره‌ای تکراری باشد پیام می‌گیرید. این تور آن را نمی‌زند.",
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
  /**
   * Effective feature flags, read only when some tour on the page asks about
   * one (`tourFactsNeeded`). Absent means "not read": a tour that needs it
   * does not match, rather than guessing.
   */
  features?: Readonly<Record<string, boolean>>;
  /** Same laziness as `features`. */
  inventorySystem?: TourInventorySystem;
}

function matchesEligibility(rule: TourEligibility, viewer: TourViewer): boolean {
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
  if (rule.anyOf && !rule.anyOf.some((alternative) => matchesEligibility(alternative, viewer))) {
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
  return matchesEligibility(tour.eligibility, viewer);
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
  const steps = tour.steps.filter((step) => !step.eligibility || matchesEligibility(step.eligibility, viewer));
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
