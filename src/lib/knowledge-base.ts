/**
 * The knowledge base — the section catalogue shared by both sides of the app.
 *
 * A `knowledge_base_entries` row (migration 0117) attaches one learning page —
 * a URL the super-admin maintains — to a dashboard section. The super-admin
 * console (`/platform/knowledge`) offers the URL for every section, and the
 * «آموزش» icon on each important dashboard page (knowledge-help.tsx) opens the
 * stored URL in a modal so a member can learn the section they are on.
 *
 * Both sides must name the same sections, so the catalogue lives in this one
 * pure module instead of on either side. Adding a page to the catalogue is
 * enough for it to appear in the console's list and to be learnable from its
 * route — the icon itself is mounted on the page's header.
 *
 * The table is a platform catalogue in the `feature_flags`/`plans` shape
 * (migrations 0021/0034): it holds no `business_id`, because the same pages
 * teach every business. Tenant routes read it (active rows only, via
 * `GET /api/knowledge`); it is written only through `/api/platform/knowledge`
 * under a platform session.
 */

import { ACCOUNTING_WORKSPACE_HREFS, WORKSPACE_MODULE_HOME } from "./app-routes";

export interface KnowledgeSection {
  /** Stable key stored in `knowledge_base_entries.section`. */
  key: string;
  /** Persian label, shown in the console and in the learning modal. */
  label: string;
  /** The dashboard route this section's learning icon lives on. */
  route: string;
}

/**
 * Every surface that carries a learning icon.
 *
 * The routes are the *public* ones: the apps left `/dashboard/<app>` for their
 * own top-level prefixes (`/accounting`, `/growth`, `/crm`, `/websites`) and
 * settings for `/settings`, so a catalogue still keyed on the old addresses
 * would mean `sectionForPathname` matching nothing and the «آموزش» icon
 * quietly vanishing from every page inside an app. Order is the console's
 * list order — top to bottom, the way a member meets the app: the daily
 * screens first, then money and people, then the growth app, then the retail
 * trades' screens (only one of the last four is ever visible to a business).
 */
export const KNOWLEDGE_SECTIONS: readonly KnowledgeSection[] = [
  { key: "pos", label: "فروش (صندوق)", route: ACCOUNTING_WORKSPACE_HREFS.pos },
  { key: "orders", label: "سفارش‌ها", route: "/accounting/orders" },
  { key: "customers", label: "مشتریان", route: "/crm/directory" },
  { key: "inventory", label: "انبار", route: ACCOUNTING_WORKSPACE_HREFS.inventory },
  { key: "reports", label: "گزارش‌ها", route: ACCOUNTING_WORKSPACE_HREFS.reports },
  { key: "settings", label: "تنظیمات", route: "/settings" },
  { key: "ledger", label: "حسابداری", route: "/accounting" },
  { key: "reservations", label: "رزروها", route: ACCOUNTING_WORKSPACE_HREFS.reservations },
  { key: "delivery", label: "ارسال سفارش", route: ACCOUNTING_WORKSPACE_HREFS.delivery },
  { key: "connections", label: "اتصال‌های فنی", route: "/settings/connections" },
  { key: "website", label: "وب‌سایت", route: "/websites" },
  // Phase G — «پروژه‌ها» grew into «میز کار من». The KEY is unchanged on
  // purpose: it is stored in `knowledge_base_entries.section`, so renaming it
  // would orphan every guide a business has already written.
  { key: "projects", label: "میز کار من", route: WORKSPACE_MODULE_HOME },
  // The assistant is not a section of the learning centre's route table: it
  // is the workspace home itself (`/dashboard`), covered by no pathname in
  // this list — the chat home carries its own in-context guidance instead.
  { key: "kitchen", label: "آشپزخانه", route: ACCOUNTING_WORKSPACE_HREFS.kitchen },
  { key: "floor", label: "نقشهٔ سالن", route: ACCOUNTING_WORKSPACE_HREFS.floor },
  { key: "waiter", label: "میزهای من", route: "/accounting/waiter" },
  { key: "growth", label: "رشد و بازاریابی", route: "/growth" },
  { key: "loyalty", label: "وفاداری", route: "/growth/loyalty" },
  { key: "campaigns", label: "کمپین‌ها", route: "/growth/campaigns" },
  { key: "gift-cards", label: "کارت هدیه", route: "/growth/gift-cards" },
  { key: "commission", label: "پورسانت فروشندگان", route: "/growth/commission" },
  { key: "jewelry", label: "طلا و جواهر", route: "/accounting/jewelry" },
  { key: "watch", label: "ساعت", route: "/accounting/watch" },
  { key: "automotive", label: "خودرو و نمایشگاه اتومبیل", route: "/accounting/automotive" },
  { key: "accessories", label: "اکسسوری", route: ACCOUNTING_WORKSPACE_HREFS.products },
  { key: "cosmetics", label: "آرایشی و بهداشتی", route: ACCOUNTING_WORKSPACE_HREFS.cosmetics },
];

/**
 * Page-specific help targets used by the article editor. The old
 * KNOWLEDGE_SECTIONS remain as fallbacks for existing published guides and
 * external help URLs; a page assignment always wins when present.
 *
 * Each entry is a real destination with a KnowledgeHelpButton (including
 * pages served by the shared CRM/Growth/CMS/WordPress and ledger shells).
 * Keys are stored in knowledge_articles.section_keys without a migration.
 */
export interface KnowledgePage {
  key: string;
  route: string;
  label: string;
  group: string;
}

function pageGroup(group: string, pages: readonly (readonly [route: string, label: string])[]): KnowledgePage[] {
  return pages.map(([route, label]) => ({ key: `page:${route}`, route, label, group }));
}

export const KNOWLEDGE_PAGES: readonly KnowledgePage[] = [
  ...pageGroup("فروش و عملیات", [
    ["/accounting/pos", "صندوق فروش"],
    ["/accounting/orders", "سفارش‌ها"],
    ["/accounting/inventory", "انبار"],
    ["/accounting/reports", "گزارش‌های کسب‌وکار"],
    ["/accounting/reservations", "رزروها"],
    ["/accounting/delivery", "ارسال و پیک"],
    ["/accounting/floor", "نقشهٔ سالن"],
    ["/accounting/kitchen", "آشپزخانه"],
    ["/accounting/waiter", "میزهای من"],
    ["/accounting/jewelry", "طلا و جواهر"],
    ["/accounting/watch", "ساعت"],
    ["/accounting/cosmetics", "آرایشی و بهداشتی"],
    ["/accounting/products", "محصولات"],
    ["/accounting/products/new", "افزودن محصول"],
    ["/accounting/products/prices", "به‌روزرسانی قیمت‌ها"],
    ["/accounting/products/attributes", "ویژگی‌های محصول"],
    ["/accounting/products/reports", "گزارش‌های کالا"],
    ["/accounting/products/barcode-templates", "الگوهای بارکد"],
  ]),
  ...pageGroup("حسابداری", [
    ["/accounting/overview", "داشبورد حسابداری"],
    ["/accounting/ledger", "فضای کار حسابداری"],
    ["/accounting/trial-balance", "تراز آزمایشی"],
    ["/accounting/entries", "دفتر روزنامه"],
    ["/accounting/manual", "ثبت سند دستی"],
    ["/accounting/expenses", "هزینه‌ها"],
    ["/accounting/fiscal-periods", "دوره‌های مالی"],
    ["/accounting/directory", "اشخاص"],
    ["/accounting/receivables", "حساب‌های دریافتنی"],
    ["/accounting/payables", "حساب‌های پرداختنی"],
    ["/accounting/receipts", "دریافت و پرداخت"],
    ["/accounting/installments", "اقساط"],
    ["/accounting/cheques", "چک‌ها"],
    ["/accounting/reconciliation", "تطبیق بانکی"],
    ["/accounting/multicurrency", "ارز و تسعیر"],
    ["/accounting/chart-of-accounts", "سرفصل حساب‌ها"],
    ["/accounting/dimensions", "ابعاد حسابداری"],
    ["/accounting/payroll", "حقوق و دستمزد"],
    ["/accounting/vat", "گزارش مالیات"],
    ["/accounting/tax-invoices", "صورتحساب مؤدیان"],
    ["/accounting/fixed-assets", "دارایی‌های ثابت"],
    ["/accounting/financial-reports", "گزارش‌های مالی"],
    ["/accounting/growth", "رشد در حسابداری"],
    ["/accounting/settings", "تنظیمات حسابداری"],
  ]),
  ...pageGroup("ارتباط با مشتری (CRM)", [
    ["/crm/overview", "میز کار CRM"],
    ["/crm/directory", "مشتریان CRM"],
    ["/crm/persons", "پروندهٔ شخص"],
    ["/crm/deals", "فرصت‌ها"],
    ["/crm/leads", "سرنخ‌ها"],
    ["/crm/activities", "کارها و پیگیری‌ها"],
    ["/crm/cases", "تیکت‌های خدمات"],
    ["/crm/segments", "بخش‌بندی مشتری"],
    ["/crm/consent", "رضایت ارتباط"],
    ["/crm/quality", "کیفیت داده"],
    ["/crm/audit", "سابقهٔ تصمیم‌ها"],
    ["/crm/settings", "تنظیمات CRM"],
  ]),
  ...pageGroup("رشد و بازاریابی", [
    ["/growth/overview", "میز کار رشد"],
    ["/growth/customers", "مخاطبان"],
    ["/growth/campaigns", "کمپین‌ها"],
    ["/growth/messaging", "پیام‌رسانی"],
    ["/growth/gift-cards", "کارت هدیه"],
    ["/growth/loyalty", "وفاداری و اعتبار"],
    ["/growth/commission", "پورسانت فروشندگان"],
    ["/growth/settings", "تنظیمات رشد"],
  ]),
  ...pageGroup("وب‌سایت و اشوبه CMS", [
    ["/websites/overview", "میز کار وب‌سایت‌ها"],
    ["/websites/cms", "میز کار سایت اشوبه"],
    ["/websites/cms/setup", "ساخت سایت"],
    ["/websites/cms/pages", "صفحه‌های سایت"],
    ["/websites/cms/posts", "نوشته‌های سایت"],
    ["/websites/cms/media", "رسانه‌های سایت"],
    ["/websites/cms/products", "محصولات سایت"],
    ["/websites/cms/orders", "سفارش‌های سایت"],
    ["/websites/cms/design", "طراحی و پوسته"],
    ["/websites/cms/domain", "دامنه و DNS"],
    ["/websites/cms/settings", "تنظیمات سایت"],
    ["/websites/cms/billing", "اشتراک سایت"],
  ]),
  ...pageGroup("وردپرس و ووکامرس", [
    ["/websites/wp", "میز کار وردپرس"],
    ["/websites/wp/products", "محصولات وردپرس"],
    ["/websites/wp/orders", "سفارش‌های وردپرس"],
    ["/websites/wp/customers", "مشتریان وردپرس"],
    ["/websites/wp/taxonomies", "دسته‌ها و ویژگی‌های وردپرس"],
    ["/websites/wp/content", "محتوای وردپرس"],
    ["/websites/wp/media", "رسانه‌های وردپرس"],
    ["/websites/wp/queue", "صف و رویدادهای وردپرس"],
  ]),
  ...pageGroup("میز کار من", [
    ["/workspace", "میز کار من"],
    ["/workspace/projects", "پروندهٔ پروژه"],
  ]),
  ...pageGroup("تنظیمات پلتفرم", [
    ["/settings", "تنظیمات"],
    ["/settings/connections", "اتصال‌های فنی"],
  ]),
];

/** Page-level match: longer (more specific) route beats its parent section. */
export function knowledgePageForPathname(pathname: string): KnowledgePage | undefined {
  let best: KnowledgePage | undefined;
  for (const page of KNOWLEDGE_PAGES) {
    if (pathname !== page.route && !pathname.startsWith(`${page.route}/`)) continue;
    if (!best || page.route.length > best.route.length) best = page;
  }
  return best;
}

export function knowledgePage(key: string): KnowledgePage | undefined {
  return KNOWLEDGE_PAGES.find((page) => page.key === key);
}

/** The catalogue entry for a key, or undefined for a key the code does not know. */
export function knowledgeSection(key: string): KnowledgeSection | undefined {
  return KNOWLEDGE_SECTIONS.find((s) => s.key === key);
}

export function isKnownKnowledgeSection(key: string): boolean {
  return knowledgeSection(key) !== undefined;
}

/**
 * Which section a dashboard pathname belongs to — the longest matching route
 * wins, so `/growth/loyalty` resolves to «وفاداری», not to the
 * growth home it sits under, and an order detail stays in «سفارش‌ها». Routes
 * the catalogue does not know (the chat home, …) resolve to undefined: their
 * pages simply carry no learning icon.
 */
export function sectionForPathname(pathname: string): KnowledgeSection | undefined {
  let best: KnowledgeSection | undefined;
  for (const section of KNOWLEDGE_SECTIONS) {
    const hit = pathname === section.route || pathname.startsWith(`${section.route}/`);
    if (!hit) continue;
    if (!best || section.route.length > best.route.length) best = section;
  }
  return best;
}

export interface ParsedKnowledgeUrl {
  ok: true;
  url: string;
}

/**
 * A learning page is a page the member's browser will load in the modal, so
 * only http(s) URLs are accepted. Trimmed of surrounding whitespace; the
 * check runs on the wire value the console sent, not on anything the browser
 * already knows.
 */
export function parseKnowledgeUrl(raw: unknown): ParsedKnowledgeUrl | { ok: false; error: "invalid_url" } {
  if (typeof raw !== "string") return { ok: false, error: "invalid_url" };
  const url = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, error: "invalid_url" };
  try {
    new URL(url);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  return { ok: true, url };
}
