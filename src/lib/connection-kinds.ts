/**
 * What the «اتصال‌های فنی» hub can connect to, and who may set each one up.
 *
 * This hub is the one home for *every* technical connection in the product —
 * desktop pairing, WordPress/WooCommerce, the Eshobe CMS site, Holoo, the
 * remote server sync, MCP and API keys. It is deliberately not an app
 * (src/lib/apps.ts): a technical utility of the shell, never listed in the
 * platform switchboard, never badged, never gated by availability. Any
 * connection surface anywhere else in the product redirects here, and the
 * product screens that *use* a connection (the website managers, the ledger)
 * manage their own subject only.
 *
 * Kept pure so its visibility rules are unit tested rather than asserted by
 * reading JSX. It follows `settings-tabs.ts`'s shape deliberately — same
 * role/feature/module vocabulary — because it is the same kind of decision.
 */
import type { Role } from "./auth";
import type { Industry } from "./industries";
import { hasModule } from "./industry-profile";

export const CONNECTION_KIND_KEYS = [
  "desktop",
  "local_devices",
  "woocommerce",
  "website",
  "holoo",
  "mcp",
  "api",
] as const;
export type ConnectionKindKey = (typeof CONNECTION_KIND_KEYS)[number];

export interface ConnectionKind {
  key: ConnectionKindKey;
  label: string;
  /** One line under the tab heading: what this connection is for, in the owner's terms. */
  description: string;
  allowedRoles: Role[];
  /**
   * The flag that gates it, if any. A *lockable* flag does not hide the tab —
   * the tab renders a read-only preview, the same treatment the nav gives a
   * locked page — so this is "which entitlement does this need", not "hide me".
   */
  feature?: string;
}

export const CONNECTION_KINDS: ConnectionKind[] = [
  {
    key: "desktop",
    label: "دسکتاپ و همگام‌سازی ابری",
    description:
      "چرخهٔ کامل اتصال دسکتاپ به ابر: صدور کد، آماده‌سازی دادهٔ اولیه، فعال‌سازی امن، سلامت همگام‌سازی، تعمیر و لغو دستگاه.",
    // Redeeming a code hands over a snapshot of the whole business, including
    // credential hashes. That is an owner's decision, like inviting a member.
    allowedRoles: ["owner"],
  },
  {
    key: "local_devices",
    label: "دستگاه‌های محلی",
    description:
      "اتصال امن تلفن و تبلت به همین رایانه از طریق HTTPS؛ انتخاب شبکه، گواهی محلی، QR و قانون محدود فایروال ویندوز.",
    allowedRoles: ["owner"],
  },
  {
    key: "woocommerce",
    label: "وردپرس و ووکامرس",
    description:
      "اتصال فروشگاه وردپرسی — با افزونهٔ وردپرس یا کلیدهای REST ووکامرس: سفارش، محصول، مشتری، موجودی و قیمت، با ثبت خودکار حسابداری. مدیریت فروشگاه (محصولات، سفارش‌ها، محتوا) در «مدیریت وب‌سایت» است؛ اینجا فقط اتصال.",
    allowedRoles: ["owner", "manager"],
    feature: "integrations",
  },
  {
    key: "website",
    label: "سایت‌ساز اشوبه",
    description:
      "اتصال سایت روی سایت‌ساز پلتفرم به همین حساب: آدرس سایت‌ساز، دامنه و کلید API، با آزمایش اتصال. مدیریت خودِ سایت (محتوا، فروشگاه، همگام‌سازی قیمت و موجودی) در «مدیریت وب‌سایت» است؛ اینجا فقط اتصال.",
    // Same line as «مدیریت وب‌سایت» itself: both managers are owner/manager
    // work, and the CMS half carries no feature entitlement, so neither does
    // this tab. (The site-building wizard lives in the website app; this tab
    // is for connecting a site that already exists.)
    allowedRoles: ["owner", "manager"],
  },
  {
    key: "holoo",
    label: "نرم‌افزار هلو",
    description:
      "اتصال به دیتابیس هلو برای مهاجرت یا کار در حالت همراه: اپ روی داده‌های خود هلو کار می‌کند در حالی که دفتر رسمی هلو می‌ماند.",
    allowedRoles: ["owner", "manager"],
    feature: "integrations",
  },
  {
    key: "mcp",
    label: "دستیارهای هوش مصنوعی",
    description:
      "اتصال امن Claude، ChatGPT و دستیارهای مشابه به همین کسب‌وکار: پرسیدن از داده‌ها و — در صورت اجازهٔ شما — انجام تغییرها.",
    // Same reasoning as the two below: this hands a program continuous access
    // to a whole branch's orders, stock, customers and ledger, and (if the
    // owner grants it) the ability to change them. That is an owner's decision
    // in the same way inviting a member is.
    allowedRoles: ["owner"],
    feature: "api_platform",
  },
  {
    key: "api",
    label: "کلیدهای API",
    description:
      "کلید دسترسی برای برنامه‌هایی که خودتان یا توسعه‌دهنده‌تان روی داده‌های همین کسب‌وکار می‌سازید.",
    // Same reasoning as the desktop tab: a key is a long-lived machine
    // credential over a whole branch's data.
    allowedRoles: ["owner"],
    feature: "api_platform",
  },
];

export interface ConnectionKindVisibilityOptions {
  role: Role;
  /** Omitted where no business is in hand; then no module filtering applies. */
  industry?: Industry;
}

/**
 * Which tabs this member sees.
 *
 * Note what is *not* here: the feature flag. A tab whose entitlement is off
 * still renders — locked, as a preview — because these are things a business
 * buys, and a page that simply vanishes cannot tell anyone it exists. Role is
 * different: it is not a purchase, and a manager has no business being shown
 * an owner-only credential form at all.
 *
 * The industry module is `connections` for this technical hub, and it is a core
 * module every trade has — but it is checked rather than assumed, so that a
 * future profile which drops it drops this page with it. The separate
 * `integrations` module belongs to the WordPress *management* half of
 * «مدیریت وب‌سایت», not to any connection.
 */
export function visibleConnectionKinds(options: ConnectionKindVisibilityOptions): ConnectionKind[] {
  if (options.industry && !hasModule(options.industry, "connections")) return [];
  return CONNECTION_KINDS.filter((kind) => kind.allowedRoles.includes(options.role));
}

export function isConnectionKindKey(value: string | null | undefined): value is ConnectionKindKey {
  return typeof value === "string" && (CONNECTION_KIND_KEYS as readonly string[]).includes(value);
}

/**
 * The tab to open, given whatever `?tab=` said and what this member can see.
 *
 * Falls back to the first visible tab rather than to a fixed default: an
 * unrecognised value, or one naming a tab this role cannot see, must not
 * produce an empty page.
 */
export function resolveConnectionKind(
  requested: string | null | undefined,
  visible: ConnectionKind[],
): ConnectionKindKey | null {
  if (visible.length === 0) return null;
  if (isConnectionKindKey(requested) && visible.some((kind) => kind.key === requested)) return requested;
  return visible[0].key;
}
