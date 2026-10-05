import type { Role } from "./auth";
import type { Industry } from "./industries";
import { hasModule, type ModuleKey } from "./industry-profile";
import { PERMISSIONS, type Permission } from "./permissions";

export const SETTINGS_TAB_KEYS = [
  "business",
  "tax",
  "pricing",
  "online-platforms",
  "payment-methods",
  "accounts",
  "team",
  "printers",
  "cloud-sync",
  "branch-management",
  // No `server-sync`: remote-server sync is a technical connection and lives
  // in the «اتصال‌های فنی» hub («سرور راه دور», owner-only, `site_cloud_sync`).
  // «تنظیمات» keeps no copy; the old `?tab=server-sync` deep link redirects
  // to the hub in `settings-manager.tsx`.
  "devices",
  "desktop",
  "notifications",
  "shifts",
  "audit-log",
  "security-center",
  "backup",
  "logs",
  "data-transfer",
] as const;

export type SettingsTabKey = (typeof SETTINGS_TAB_KEYS)[number];

export interface SettingsTab {
  key: SettingsTabKey;
  label: string;
  description: string;
  requiredAnyPermission?: Permission[];
  allowedRoles?: Role[];
  feature?: string;
  /** Show when at least one of these feature flags is enabled. */
  requiredAnyFeature?: string[];
  /**
   * Phase 25 — the industry module this tab belongs to. A tab naming a module
   * the business's trade does not have is dropped entirely, the same way its
   * nav entry and its API route are.
   */
  module?: ModuleKey;
  /**
   * Rewrites the tab's label/description for a given industry. Only used where
   * the F&B wording would be actively wrong — «نرخ هر دسته از منو» in a
   * jewellery shop — not as a general translation table.
   */
  industryText?: (industry: Industry) => { label?: string; description?: string };
}

/**
 * A tab after `visibleSettingsTabs` has resolved it — what a caller actually
 * gets back, and deliberately *not* a `SettingsTab`.
 *
 * `industryText` is an authoring detail of the table above: a function, and so
 * the one field on a tab that cannot cross the server/client boundary. The
 * settings page is a server component that hands its resolved tabs straight to
 * `<SettingsManager>`, a client one, and React refuses to serialize a function
 * prop — "Functions cannot be passed directly to Client Components" — which
 * surfaces as a 500 on /dashboard/settings, not as a build error. Dropping the
 * field at the point the wording is resolved makes that unrepresentable rather
 * than something each call site has to remember.
 */
export type ResolvedSettingsTab = Omit<SettingsTab, "industryText">;

export interface SettingsTabVisibilityOptions {
  role?: Role;
  features?: Record<string, boolean>;
  /** Omitted by callers with no business in hand; then no module or wording filtering applies. */
  industry?: Industry;
}

export const SETTINGS_TABS: SettingsTab[] = [
  {
    key: "business",
    label: "کسب‌وکار و شعبه",
    description: "اطلاعات تماس، واحد پول و اطلاعات رسید",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
  },
  {
    key: "tax",
    label: "مالیات",
    description: "نرخ پیش‌فرض و نرخ هر دسته از منو",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
    // Per-category rates are a menu concept; a retail business only has the
    // default rate here, so promising "هر دسته از منو" would be a lie.
    industryText: (industry) =>
      hasModule(industry, "menu") ? {} : { description: "نرخ پیش‌فرض مالیات بر ارزش افزوده" },
  },
  {
    key: "pricing",
    label: "قیمت‌گذاری",
    description: "حاشیه سود، سربار و هشدار تغییر بهای آیتم‌های منو",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
    // This policy is the recipe-backed `menu_items` cost-plus engine. Retail
    // trades price their `items` through trade-specific formulas (gold,
    // serialized watches, variants, etc.); showing this tab there promised a
    // default margin that none of those engines ever read.
    module: "menu",
  },
  {
    key: "online-platforms",
    label: "پلتفرم‌های سفارش آنلاین",
    description: "نرخ کارمزد اسنپ‌فود، برای ثبت خودکار هنگام تسویه سفارش",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
    // SnapFood is food delivery; the commission account and the whole tab are
    // meaningless outside F&B.
    module: "delivery",
  },
  {
    key: "payment-methods",
    label: "روش‌های پرداخت",
    description: "روش‌های دریافت وجه، ترتیب نمایش آن‌ها در صندوق، و تقسیم مبلغ بین چند روش",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
  },
  {
    key: "accounts",
    label: "حسابداری",
    description: "سرفصل‌ها، حساب‌های سیستمی، گردش حساب و تاریخچهٔ تغییرات",
    requiredAnyPermission: [PERMISSIONS.accountsEdit],
  },
  {
    key: "team",
    label: "کاربران و دسترسی‌ها",
    description: "اعضا، دعوت‌ها و مجوزهای اختصاصی",
    requiredAnyPermission: [PERMISSIONS.teamManage],
  },
  {
    key: "printers",
    label: "چاپ و فاکتور",
    description: "قالب‌های رسید و فاکتور، طراحی قالب اختصاصی، لوگو، چاپگرهای شعبه و کشوی پول",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
  },
  {
    key: "cloud-sync",
    label: "ابر و همگام‌سازی",
    description: "وضعیت سیستم محلی، اتصال ابری، صف همگام‌سازی و اتصال به ابر",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
  },
  {
    key: "branch-management",
    label: "مدیریت شعب",
    description: "مدیریت شعب کسب‌وکار و همگام‌سازی داده‌های شعب با سرور مرکزی",
    // The same permission `/api/branches` is gated on, not `allowedRoles:
    // ["owner"]`. A hard role list disagreed with the routes behind the tab:
    // an owner who granted `locations.manage` to a manager gave them a
    // permission whose only screen they still could not open, and the manage
    // /add forms were reachable by API alone. `locations.manage` is in no
    // role's preset, so this is still owner-only until it is deliberately
    // delegated — the difference is that delegating it now works.
    requiredAnyPermission: [PERMISSIONS.locationsManage],
    requiredAnyFeature: ["multi_location", "site_cloud_sync"],
  },
  {
    key: "devices",
    label: "دستگاه‌های ثبت‌شده",
    description: "پایانه‌های متصل و ورود بیومتریک اختصاصی هر دستگاه",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
  },
  {
    key: "desktop",
    label: "دسکتاپ و به‌روزرسانی",
    description: "نسخهٔ نصب‌شده، کانال انتشار، دانلود امن، بستهٔ آفلاین و نصب پس از پشتیبان",
    allowedRoles: ["owner"],
  },
  {
    key: "notifications",
    label: "اعلان‌ها",
    description: "اینکه چه چیزی روی گوشی و رایانهٔ شما اعلان شود، و ساعت‌هایی که نباید مزاحمتان شد",
    // Deliberately open to every role and every permission: this tab edits only
    // the caller's OWN devices and rules (see requireMember in auth.ts), and an
    // آشپز who wants a notification on their own phone is not performing a
    // manager-level act. It gates nothing because there is nothing to gate.
  },
  {
    key: "shifts",
    label: "شیفت‌ها و روز کاری",
    description: "ساعت شروع روز کاری شعبه، بستن روز، و تاریخچهٔ ورود/خروج کارکنان و تطبیق صندوق هر شیفت",
    requiredAnyPermission: [PERMISSIONS.teamManage],
  },
  {
    key: "audit-log",
    label: "گزارش حسابرسی",
    description: "رویدادهای امنیتی کسب‌وکار: ورود، تغییر اعتبارنامه، دستگاه و شیفت",
    requiredAnyPermission: [PERMISSIONS.teamManage],
  },
  {
    key: "security-center",
    label: "مرکز امنیت",
    description:
      "نشست‌های فعال، تلاش‌های ورود ناموفق و کارمندان قفل‌شده، با امکان پایان‌دادن به نشست یا رفع قفل",
    requiredAnyPermission: [PERMISSIONS.teamManage],
  },
  {
    key: "backup",
    label: "پشتیبان‌گیری",
    description: "وضعیت، اجرای دستی و زمان‌بندی پشتیبان‌گیری",
    allowedRoles: ["owner", "manager"],
    feature: "backup",
  },
  {
    key: "logs",
    label: "گزارش‌ها",
    description: "خطاهای ثبت‌شدهٔ این مرورگر و — روی نسخهٔ دسکتاپ — گزارش کامل سرور محلی",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
  },
  {
    key: "data-transfer",
    label: "ورود و خروج داده",
    description:
      "ورود گروهی از CSV/Excel/JSON/PDF و خروجی گرفتن از همهٔ بخش‌ها، با نگاشت ستون‌ها، قالب‌ها، زمان‌بندی و تاریخچه",
    // Either key is enough to open the tab; the screen then shows only the
    // directions this member actually holds, and every route re-checks the
    // *entity's* own permission on top. A tab gated on both would hide the
    // export screen from somebody who may export but not import.
    requiredAnyPermission: [PERMISSIONS.dataExport, PERMISSIONS.dataImport],
  },
];

export function visibleSettingsTabs(
  permissions: Iterable<Permission | string>,
  options: SettingsTabVisibilityOptions = {},
): ResolvedSettingsTab[] {
  const granted = new Set(permissions);
  const industry = options.industry;
  return SETTINGS_TABS.filter((tab) => {
    if (tab.requiredAnyPermission && !tab.requiredAnyPermission.some((permission) => granted.has(permission))) {
      return false;
    }
    if (tab.allowedRoles && (!options.role || !tab.allowedRoles.includes(options.role))) return false;
    if (tab.feature && !options.features?.[tab.feature]) return false;
    if (tab.requiredAnyFeature && !tab.requiredAnyFeature.some((feature) => options.features?.[feature])) return false;
    if (tab.module && industry && !hasModule(industry, tab.module)) return false;
    return true;
  }).map(({ industryText, ...tab }) => {
    // Rewrite wording only once the industry is known; a caller without one
    // (a test, a context with no business) keeps the F&B defaults it always had.
    // `industryText` is destructured off unconditionally rather than spread
    // along with the rest — see ResolvedSettingsTab for why it must not travel.
    const text = industry && industryText ? industryText(industry) : null;
    return text && (text.label || text.description)
      ? { ...tab, label: text.label ?? tab.label, description: text.description ?? tab.description }
      : tab;
  });
}

export function isSettingsTabKey(value: string | null): value is SettingsTabKey {
  return value !== null && (SETTINGS_TAB_KEYS as readonly string[]).includes(value);
}
