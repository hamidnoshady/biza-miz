/**
 * The «مدیریت وب‌سایت» menu: two groups, one per manager.
 *
 * Framework-free (no React, no db) so the list is unit-tested and can be read
 * by anything that needs to link into the app; the icons live in the nav
 * component, the same split the CRM and Growth apps use. This file answers
 * "what sections exist, what are they called, and which manager owns them".
 *
 * The two groups are deliberately separate lists rather than one flat menu
 * with a prefix on each label. A business that runs a WordPress shop and a
 * platform site at the same time is looking at two different systems with two
 * different connections, two different content models and two different
 * places its prices come from; a single list would invite the reading that
 * «محصولات» means the same thing in both, and it does not.
 */
import { CMS_SECTION_KEYS, type CmsSectionKey, type WebsiteManagerKey } from "./website-routes";
import { WP_SECTION_KEYS, type WpSectionKey } from "./wp/wp-routes";

export interface WebsiteNavItem<K extends string = string> {
  key: K;
  label: string;
  /** One line under the label — what the section is for, in the owner's terms. */
  description: string;
}

export interface WebsiteNavGroup {
  manager: WebsiteManagerKey;
  /** The manager's name, as the app home and this menu both call it. */
  label: string;
  /** One line under the group heading. */
  description: string;
}

export const WEBSITE_NAV_GROUPS: readonly WebsiteNavGroup[] = [
  {
    manager: "cms",
    label: "سایت‌ساز اشوبه",
    description: "سایت و فروشگاه اینترنتی روی پلتفرم خودمان.",
  },
  {
    manager: "wp",
    label: "وردپرس و ووکامرس",
    description: "سایت وردپرسی که خودتان دارید.",
  },
];

export const CMS_NAV_ITEMS: readonly WebsiteNavItem<CmsSectionKey>[] = [
  { key: "overview", label: "میز کار سایت", description: "وضعیت سایت و پیش‌نمایش زنده." },
  { key: "setup", label: "ساخت سایت", description: "دامنه، CDN آروان، نوع سایت و ساخت." },
  { key: "pages", label: "صفحه‌ها", description: "برگه‌های ثابت سایت." },
  { key: "posts", label: "نوشته‌ها", description: "مطالب وبلاگ و اخبار." },
  { key: "media", label: "رسانه‌های سایت", description: "تصاویر و فایل‌های سایت." },
  { key: "products", label: "محصولات سایت", description: "کالاهای فروشگاه اینترنتی." },
  { key: "orders", label: "سفارش‌های سایت", description: "سفارش‌های آنلاین و وضعیت آن‌ها." },
  { key: "design", label: "طراحی و پوسته", description: "پوسته، استقرار و تنظیمات ظاهر." },
  { key: "domain", label: "دامنه و DNS", description: "دامنه، رکوردها و CDN." },
  { key: "settings", label: "تنظیمات همگام‌سازی", description: "اینکه قیمت و موجودی کدام کالا به سایت برود." },
  { key: "billing", label: "اشتراک و صورت‌حساب", description: "هزینهٔ سایت، دامنه و تمدید." },
];

export const WP_NAV_ITEMS: readonly WebsiteNavItem<WpSectionKey>[] = [
  { key: "overview", label: "میز کار فروشگاه", description: "وضعیت اتصال و همگام‌سازی." },
  // No `connections` entry: the store connection lives in the «اتصال‌های فنی»
  // hub, and the overview links there when no store is linked yet.
  { key: "products", label: "محصولات", description: "کالاهای همگام‌شده و عملیات فروشگاه." },
  { key: "orders", label: "سفارش‌ها", description: "سفارش‌های آنلاین، وضعیت و برگشت وجه." },
  { key: "customers", label: "مشتریان فروشگاه", description: "مشتریان همگام‌شده از فروشگاه." },
  { key: "taxonomies", label: "دسته‌بندی و ویژگی‌ها", description: "درخت دسته‌بندی، برچسب و ویژگی‌ها." },
  { key: "content", label: "محتوای وردپرس", description: "نوشته‌ها و برگه‌های وردپرس." },
  { key: "media", label: "رسانه‌ها", description: "کتابخانهٔ فایل‌های فروشگاه." },
  { key: "queue", label: "صف و رویدادها", description: "کارهای در انتظار ارسال و خطاها." },
];

/** Guard rails for the two lists above; asserted in the unit test. */
export const WEBSITE_NAV_SECTION_KEYS = {
  cms: CMS_SECTION_KEYS,
  wp: WP_SECTION_KEYS,
} as const;
