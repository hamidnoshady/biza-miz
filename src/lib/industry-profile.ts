/**
 * Phase 25 Wave 2 — what a business's industry actually changes about the app.
 *
 * Phase 21 gave each industry its own chart of accounts, item model, posting
 * rules, wizard path and dashboard page — but the *shell* stayed café-shaped.
 * `businesses.industry` only ever added: it revealed the three industry pages
 * and nothing else, while every F&B module (میزها، آشپزخانه، رزروها، منو، …)
 * was gated on feature flags that no industry turns off, and every label was a
 * literal in the component that rendered it. A jewellery shop got the whole
 * café app with a "طلا و جواهر" tab bolted on and a sidebar reading
 * «کافه و رستوران».
 *
 * This is the one place that answers "what does this industry get, and what is
 * it called". It is the industry-keyed counterpart of `features.ts` — a
 * disabled module is refused at the API guard, not merely hidden from the nav —
 * and the generalisation of the pattern `wizard-steps.ts` already used for the
 * setup wizard's steps.
 *
 * Framework-free (no `db`, no `next`) exactly like `industries.ts` and
 * `wizard-steps.ts`, so client components and Edge code can import it directly.
 * The DB-touching half — resolving a business's industry and enforcing the
 * module set — lives in `industry-guard.ts`.
 *
 * Note this is **not** an i18n layer and should not grow into one. It carries
 * only the handful of nouns that genuinely differ between trades; everything
 * else stays a literal where it is rendered.
 */
import type { Industry } from "./industries";

/**
 * A dashboard area a business either has or does not have.
 *
 * These are coarser than routes on purpose: one key covers a nav entry, its
 * page(s), its API prefix and any settings tab that belongs to it, so "does
 * this business have tables?" is asked and answered once.
 */
export const MODULE_KEYS = [
  "dashboard",
  "orders",
  "pos",
  "customers",
  "loyalty",
  "promotions",
  "commission",
  "tables",
  "waiter",
  "kitchen",
  "reservations",
  "delivery",
  "inventory",
  "menu",
  "jewelry",
  "watch",
  "accessories",
  "cosmetics",
  "wholesale",
  "tools_fittings",
  "haberdashery",
  "stock",
  "ledger",
  "integrations",
  // The «اتصال‌های فنی» hub (/settings/connections): every technical
  // connection in the product — desktop pairing, WordPress/WooCommerce, the
  // Eshobe CMS site, Holoo, the remote server sync, MCP and API keys. The hub
  // is shell infrastructure, not an app (src/lib/apps.ts), so this module is
  // intentionally unassigned there: it gates *visibility* of the hub's door,
  // never availability. `integrations` stays separate: it is the WordPress
  // *management* half of «مدیریت وب‌سایت», not a connection.
  "connections",
  "reports",
  "ai",
  "settings",
  // Phase 35 — module keys for the app ecosystem and the phases that build on
  // it. `crm` (Phase 36) and `website` (Phase 36b/reversal) are wired into
  // `CORE_MODULES` below; `messaging` is still the subject of a later phase
  // and stays unassigned until it wires up its own pages. The key exists so
  // the app registry (src/lib/apps.ts) can give it a place without touching
  // the union again. There is deliberately no `workspace` key: the ecosystem
  // shell stopped being a gated module when its flag retired — the chat home
  // and the rail are the product's one shell now, for every trade, so there
  // is nothing left for such a key to gate.
  "crm",
  "website",
  "messaging",
  // Migration 0149 — «کتابخانهٔ رسانه»: the business's shared library of
  // images, videos and documents (folders, categories, AI tagging, the
  // standard product-shot refine). Core for every trade — a jeweller stores
  // product photos exactly as a café stores menu shots — and deliberately
  // unassigned in `apps.ts` like `connections`: the library is shared shell
  // infrastructure every app's pickers read from, not an app of its own, so
  // the module gates visibility, never availability.
  "media",
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/** The nouns that differ by trade. Anything not listed here is the same word everywhere. */
export type LabelKey =
  /** One sale, as a document: «سفارش» in a café, «فاکتور» in a shop. */
  | "saleDocument"
  /** Its plural, for the nav entry and list heading. */
  | "saleDocumentPlural"
  /** The screen you sell from. */
  | "sellScreen"
  /** The list of things you sell. */
  | "catalogue"
  /** One entry in that list. */
  | "catalogueItem";

export type SalesModel =
  /** F&B: an order is opened, sent to the kitchen, and settled — today's POS. */
  | "order_ticket"
  /** Retail: lines are priced onto an invoice and settled in one go (Wave 3). */
  | "retail_invoice";

/**
 * Phase 27 — a finer-grained switch than a ModuleKey: a capability lives
 * *inside* a trade's own module (or inside the POS it already has), so it has
 * no page or API prefix of its own and no nav entry to hide. Read by the UI
 * and by the trade's service layer; the routes are already gated by
 * `requireIndustryForApi`, which is the stricter check, so a capability is
 * never a third guard axis.
 */
export const CAPABILITY_KEYS = ["batch_expiry", "barcode", "repairs"] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export interface IndustryProfile {
  /** Sidebar brand block, in place of the hardcoded «کافه و رستوران». */
  brandTitle: string;
  brandSubtitle: string;
  modules: readonly ModuleKey[];
  /** Only the keys that differ from `FALLBACK_LABELS`; the rest fall through. */
  labels: Partial<Record<LabelKey, string>>;
  salesModel: SalesModel;
  /**
   * Feature flags to seed as "off" overrides at provision time, for capability
   * this industry has no use for. Seeded through the same loop
   * `LOCAL_DISABLED_FEATURES` already uses (business-provisioning.ts), and
   * stays individually flippable from the platform console afterwards — an
   * industry default, not a prohibition.
   */
  defaultDisabledFeatures: readonly string[];
  /**
   * Phase 27 — capabilities this trade has, switched on from this one place
   * rather than from an `if (industry === …)` in the app. See CAPABILITY_KEYS.
   */
  capabilities: readonly CapabilityKey[];
  /**
   * The commercial rates a fresh retail invoice line starts from, before a
   * cashier — permission allowing (`sales.invoice.discount` /
   * `sales.invoice.override_price`, see permissions.ts) — overrides them.
   *
   * This is the one place these numbers live. Before this field existed, the
   * gold form and the barcode-scan add-path each carried their own literal
   * `7`/`7`/`9`, and a business that wanted a different اجرت default had to
   * be told to type it in every time. A future per-category/per-business
   * override layer (item/category/industry/business, per the product brief)
   * still resolves down to this industry default at the bottom — it is not
   * built yet, so this is honestly the *only* tier today.
   */
  retailDefaults?: {
    vatPercent: number;
    /** Jewelry only — the گروه اجرت percent a fresh gold line proposes. */
    goldMakingChargePercent?: number;
    /** Jewelry only — the سود percent a fresh gold line proposes. */
    goldProfitPercent?: number;
  };
}

/** F&B's wording is the base: every other industry overrides only what it must. */
const FALLBACK_LABELS: Record<LabelKey, string> = {
  saleDocument: "سفارش",
  saleDocumentPlural: "سفارش‌ها",
  sellScreen: "صندوق (فروش)",
  catalogue: "منو",
  catalogueItem: "آیتم منو",
};

const RETAIL_LABELS: Partial<Record<LabelKey, string>> = {
  saleDocument: "فاکتور",
  saleDocumentPlural: "فاکتورها",
  sellScreen: "فروش و فاکتور",
  catalogue: "کالاها",
  catalogueItem: "کالا",
};

/**
 * The F&B-only modules. Named rather than inlined three times so that adding a
 * fifth industry is one line, and so the list reads as the answer to "what
 * makes a café a café": table service, a kitchen to send tickets to, bookings,
 * couriers, a recipe-costed raw-material store, and a menu.
 */
const FOOD_SERVICE_MODULES: readonly ModuleKey[] = [
  "tables",
  "waiter",
  "kitchen",
  "reservations",
  "delivery",
  "inventory",
  "menu",
];

/** What every business has regardless of trade — the core accounting/admin platform. */
const CORE_MODULES: readonly ModuleKey[] = [
  "dashboard",
  "customers",
  // Phase 36 — the CRM ships to every trade, for the same reason `customers`
  // does: a jeweller keeps a customer file exactly as a café does, and the
  // whole app is built on records (`customers`, `orders`, `payments`) every
  // profile already has. Phase 35 declared this key without assigning it,
  // because its pages did not exist yet; they do now.
  "crm",
  "loyalty",
  "promotions",
  "commission",
  // Website manager (#378) ships to every trade too: a jeweller wants a
  // storefront exactly as a café wants a menu site, and the module gates the
  // one CMS connection this app holds rather than a trade-specific screen —
  // see the "website" app in src/lib/apps.ts and docs/eshobe-cms-integration.md.
  "website",
  "ledger",
  "integrations",
  "connections",
  // Migration 0149 — the media library ships to every trade for the same
  // reason `customers` does: every business has photos and documents to keep.
  "media",
  "reports",
  "ai",
  "settings",
];

/**
 * Selling modules.
 *
 * Both industries sell from `/accounting/pos` — the route branches on
 * `salesModel` — so every profile has "pos".
 *
 * "orders" is F&B-only, and not as an oversight: `/dashboard/orders` is a live
 * board of *open* order tickets, with kitchen statuses, table filters and a
 * realtime feed. A retail invoice is settled the moment it is written, so it
 * would never appear there. The shop's sales history lives on its own selling
 * screen instead, which is also where a counter actually looks for it.
 */
const SELLING_MODULES: readonly ModuleKey[] = ["orders", "pos"];

/**
 * Phase 27 Wave 8 — purchasing/returns/transfers on the `items` model and the
 * reorder/low-stock reports. Retail-only: F&B's equivalent is `inventory`.
 */
const RETAIL_STOCK_MODULES: readonly ModuleKey[] = ["stock"];

export const INDUSTRY_PROFILES: Record<Industry, IndustryProfile> = {
  food_service: {
    brandTitle: "کافه و رستوران",
    brandSubtitle: "مدیریت عملیات روزانه",
    modules: [...CORE_MODULES, ...SELLING_MODULES, ...FOOD_SERVICE_MODULES],
    labels: {},
    salesModel: "order_ticket",
    defaultDisabledFeatures: [],
    capabilities: [],
  },
  jewelry: {
    brandTitle: "طلا و جواهر",
    brandSubtitle: "مدیریت خرید، فروش و موجودی",
    modules: [...CORE_MODULES, "pos", "jewelry", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    // `inventory` is F&B's recipe-costed raw-material store
    // (`inventory_items`/`stock_movements`); jewellery stock lives in Phase
    // 21's `items`/`item_weight_attributes` and is managed from its own page.
    // `reservations` gates tables and the floor plan, which have no meaning in
    // a shop.
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    // `repairs` (Wave 10): repair_tickets is already generic (item_description,
    // nullable serial_id), so a jeweller uses the same workflow a watch shop does.
    capabilities: ["barcode", "repairs"],
    retailDefaults: { vatPercent: 9, goldMakingChargePercent: 7, goldProfitPercent: 7 },
  },
  watch: {
    brandTitle: "ساعت",
    brandSubtitle: "مدیریت فروش، گارانتی و تعمیرات",
    modules: [...CORE_MODULES, "pos", "watch", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    capabilities: ["barcode", "repairs"],
    retailDefaults: { vatPercent: 9 },
  },
  accessories: {
    brandTitle: "بدلیجات",
    brandSubtitle: "مدیریت تنوع‌ها، موجودی و فروش",
    modules: [...CORE_MODULES, "pos", "accessories", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    capabilities: ["barcode"],
    retailDefaults: { vatPercent: 9 },
  },
  cosmetics: {
    brandTitle: "آرایشی و بهداشتی",
    brandSubtitle: "مدیریت برند، بچ و تاریخ انقضا",
    modules: [...CORE_MODULES, "pos", "cosmetics", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    capabilities: ["batch_expiry", "barcode"],
    retailDefaults: { vatPercent: 9 },
  },
  wholesale: {
    brandTitle: "عمده‌فروشی",
    brandSubtitle: "مدیریت خرید عمده، موجودی و فروش",
    modules: [...CORE_MODULES, "pos", "wholesale", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    // Same F&B-only modules off as the other retail trades; a wholesale
    // business also has no tables, kitchen, reservations or delivery flow.
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    capabilities: ["barcode"],
    retailDefaults: { vatPercent: 9 },
  },
  tools_fittings: {
    brandTitle: "ابزار و یراق‌آلات",
    brandSubtitle: "مدیریت کالا، موجودی و فروش ابزار و یراق",
    modules: [...CORE_MODULES, "pos", "tools_fittings", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    capabilities: ["barcode"],
    retailDefaults: { vatPercent: 9 },
  },
  haberdashery: {
    brandTitle: "خرازی",
    brandSubtitle: "مدیریت لوازم خیاطی، موجودی و فروش",
    modules: [...CORE_MODULES, "pos", "haberdashery", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    capabilities: ["barcode"],
    retailDefaults: { vatPercent: 9 },
  },
};

export function industryProfile(industry: Industry): IndustryProfile {
  return INDUSTRY_PROFILES[industry];
}

/** Whether this industry has a module at all — the question nav, pages and API guards all ask. */
export function hasModule(industry: Industry, module: ModuleKey): boolean {
  return INDUSTRY_PROFILES[industry].modules.includes(module);
}

/** Whether this trade has a Phase 27 capability switched on (batch expiry, barcode, repairs, …). */
export function hasCapability(industry: Industry, capability: CapabilityKey): boolean {
  return INDUSTRY_PROFILES[industry].capabilities.includes(capability);
}

/** The VAT percent a fresh retail line proposes for this industry (9 if the profile has no opinion). */
export function defaultRetailVatPercent(industry: Industry): number {
  return INDUSTRY_PROFILES[industry].retailDefaults?.vatPercent ?? 9;
}

/** Jewelry's default اجرت percent — the one place this number is defined. */
export function defaultGoldMakingChargePercent(industry: Industry): number {
  return INDUSTRY_PROFILES[industry].retailDefaults?.goldMakingChargePercent ?? 7;
}

/** Jewelry's default سود percent — the one place this number is defined. */
export function defaultGoldProfitPercent(industry: Industry): number {
  return INDUSTRY_PROFILES[industry].retailDefaults?.goldProfitPercent ?? 7;
}

/** This industry's word for something, falling back to F&B's when it has no opinion. */
export function labelFor(industry: Industry, key: LabelKey): string {
  return INDUSTRY_PROFILES[industry].labels[key] ?? FALLBACK_LABELS[key];
}

/**
 * Dashboard page prefix → the module that owns it, for each gated page's own
 * redirect. Deliberately the same shape as `features.ts`'s
 * `PAGE_FEATURE_PREFIXES`, so the two guards read alike at their call sites.
 *
 * This list must stay in lock-step with the nav (`navItemsFor` in
 * src/app/dashboard/layout.tsx): the sidebar badges an entry with the state
 * of the app that owns its *nav* module, while `AppAvailabilityGate` blocks
 * the page behind the state of the app that owns its *path* module. A page
 * missing here is a page whose badge says «به‌زودی» while its door stands
 * open — which is exactly the bug this list once had for the ledger, the
 * reports, the sales overview and the settings pages. When a nav entry is
 * added, its href's prefix belongs here, mapped to the same module.
 *
 * Deliberately ungated: `/dashboard` itself (the workspace chat home in the
 * workspace shell — the gate treats it as the sales overview only in the
 * classic shell, where that is what it renders), `/projects` and `/ai`.
 * The explanation screen has to be reachable from somewhere.
 */
export const PAGE_MODULE_PREFIXES: readonly (readonly [string, ModuleKey])[] = [
  // Operational overview belongs to Accounting; the chat home stays ungated.
  ["/overview", "dashboard"],
  ["/accounting/orders", "orders"],
  // Business work areas render beneath Accounting. The inventory page chooses
  // the food-service or retail stock model; both follow Accounting availability.
  // Every retired `/dashboard/<area>` address 308s in middleware
  // before this table is ever consulted, so only canonical prefixes live here.
  ["/accounting/pos", "pos"],
  ["/accounting/floor", "tables"],
  ["/accounting/waiter", "waiter"],
  ["/accounting/kitchen", "kitchen"],
  ["/accounting/reservations", "reservations"],
  ["/accounting/delivery", "delivery"],
  ["/accounting/inventory", "inventory"],
  ["/settings/menu", "menu"],
  ["/accounting/jewelry", "jewelry"],
  ["/accounting/watch", "watch"],
  // The products workspace is the catalogue door every retail trade-goods
  // industry shares; anchored on `stock`, the module all five of those
  // profiles carry, so a trade without the variant board never sees it.
  ["/accounting/products", "stock"],
  ["/accounting/cosmetics", "cosmetics"],
  // Phase 36b — the Growth & Marketing app's home. Anchored on `loyalty`
  // (core for every trade) like its nav entry: the app is the container for
  // loyalty, promotions and commission, and a business that had any of the
  // three has loyalty. Its own sections carry their own modules first, so a
  // trade without commission never has its badge lie about the door.
  ["/growth/commission", "commission"],
  ["/growth/campaigns", "promotions"],
  ["/growth", "loyalty"],
  // Phase 36 — the CRM app's home. Anchored on `customers` (core for every
  // trade, exactly like the flat «مشتریان» page it absorbed) rather than on the
  // `crm` module key: a business that has customers has a CRM, and gating the
  // app on a module no industry profile lists yet would hide it from everyone.
  ["/crm", "customers"],
  // «مدیریت وب‌سایت» — one app, two managers, and therefore two module
  // answers under one prefix. The WordPress/WooCommerce manager keeps its own
  // `integrations` module, so a trade that has WordPress but not the CMS (or
  // the reverse) still gets exactly the manager it has. The longer prefix is
  // listed first because the first match wins.
  ["/websites/wp", "integrations"],
  ["/websites", "website"],
  // The «اتصال‌های فنی» hub. Its module is intentionally unassigned in
  // `apps.ts` — the hub is shell infrastructure, not an app — so this prefix
  // answers the module question without ever blocking the page.
  ["/settings/connections", "connections"],
  // Migration 0149 — the media library. Its module has no owning app (like
  // `connections`), so this row gates visibility by trade without the
  // availability guard ever locking the page.
  ["/media", "media"],
  // The remaining ledger sections are covered by this broad Accounting row;
  // the business work-area rows above deliberately precede it so their owning
  // app availability remains accurate.
  ["/accounting", "ledger"],
  // Shared settings, support and knowledge are trade modules, but they are
  // unassigned in apps.ts and have no standalone app availability state.
  ["/settings", "settings"],
  ["/support", "settings"],
  ["/knowledge", "settings"],
];

/**
 * API route prefix → the module that owns it.
 *
 * Same role as `featureForApiPath`: without it, hiding a nav entry would be
 * decoration — the routes would still answer. Two axes read this list, and
 * they want different things from it: the industry guard refuses a module the
 * trade does not have, while the availability guard refuses an app that is
 * «به‌زودی» / «در حال تعمیر» / «غیرفعال». A data route missing here keeps
 * answering while its app's pages show the explanation screen.
 *
 * Deliberately ungated: cross-cutting routes every surface calls (auth,
 * customers — the POS's credit-payment picker reads the directory,
 * parties, billing, printers, devices, notifications, support, knowledge),
 * server-to-server and machine routes (rollup, server-sync, pairing, mcp,
 * v1, webhooks), and the hub's own connection endpoints (`/api/connections/*`
 * and the carved-out CMS connection routes below — the hub is not an app and
 * must keep working while any app is down).
 *
 * The per-industry routes (`/api/jewelry/*` and friends) are listed here
 * *as well as* keeping their stricter `requireIndustryForApi` handler check:
 * the module answer is the same either way, but without a row here the
 * availability guard could never refuse them and an operations «به‌زودی»
 * would block the pages while the APIs kept answering.
 *
 * First match wins — the longer CMS prefixes below must stay above the
 * catch-all `/api/cms/website`.
 */
const API_MODULE_PREFIXES: readonly (readonly [string, ModuleKey])[] = [
  ["/api/orders", "orders"],
  // Retail invoices are written and read from the selling screen itself
  // (`/accounting/pos` in invoice mode), so they belong to `pos`, not `orders`.
  ["/api/sales", "pos"],
  ["/api/dashboard", "dashboard"],
  ["/api/waiter", "waiter"],
  ["/api/menu", "menu"],
  ["/api/tables", "tables"],
  ["/api/table-sessions", "tables"],
  ["/api/floor", "tables"],
  ["/api/reservations", "reservations"],
  ["/api/kitchen", "kitchen"],
  ["/api/deliveries", "delivery"],
  ["/api/couriers", "delivery"],
  ["/api/inventory", "inventory"],
  // Migration 0149 — the media library's data routes. `media` is core for
  // every trade and owned by no app (the availability guard fails open, like
  // `connections`), so this row exists for the industry guard's completeness
  // rather than to lock anything.
  ["/api/media", "media"],
  ["/api/loyalty", "loyalty"],
  ["/api/promotions", "promotions"],
  ["/api/commission", "commission"],
  // The Growth & Marketing app's own API surface, anchored on `loyalty` like
  // its pages: every trade with growth has loyalty.
  ["/api/growth", "loyalty"],
  // Phase 36 — the CRM app's routes. The customer *directory* (`/api/customers`)
  // stays ungated: every trade has customers, and the POS's credit-payment
  // picker calls it. What the `crm` module gates is the CRM's own surfaces —
  // segments, the pipeline, cases, consent history.
  ["/api/crm", "crm"],
  // The accounting suite's data routes — without these, an accounting
  // «به‌زودی» would badge the pages while every figure kept loading.
  ["/api/ledger", "ledger"],
  ["/api/reports", "reports"],
  // The pricing settings route configures recipe-backed menu suggestions. It
  // must follow the tab's menu gate rather than the broader settings module;
  // longer prefixes stay before the catch-all because first match wins.
  ["/api/settings/pricing", "menu"],
  ["/api/settings", "settings"],
  // The per-industry data routes. See the note above: the stricter
  // `requireIndustryForApi` check at each handler stays; this row is what lets
  // the availability guard refuse them with the rest of operations.
  ["/api/jewelry", "jewelry"],
  ["/api/watch", "watch"],
  // Phase 42 — the shared products-workspace routes; the handlers re-check
  // the industry set themselves (requireProductWorkspaceForApi).
  ["/api/products", "stock"],
  ["/api/accessories", "accessories"],
  ["/api/cosmetics", "cosmetics"],
  ["/api/wholesale", "wholesale"],
  ["/api/tools-fittings", "tools_fittings"],
  ["/api/haberdashery", "haberdashery"],
  // The CMS connection endpoints the «اتصال‌های فنی» hub owns — state, connect
  // and disconnect, plus the site-domain change. Mapped to the hub's own
  // `connections` module (which has no app, so the availability guard fails
  // open) rather than left to the `/api/cms/website` catch-all below: the hub
  // must keep managing the credential while the website app itself is down.
  // The domain *purchase* endpoints stay website-owned — buying a domain is
  // the setup wizard's business, not the hub's — so they are listed first.
  ["/api/cms/website/domain/quote", "website"],
  ["/api/cms/website/domain/order", "website"],
  ["/api/cms/website/state", "connections"],
  ["/api/cms/website/connect", "connections"],
  ["/api/cms/website/connection", "connections"],
  ["/api/cms/website/domain", "connections"],
  // Only the website manager's own screen — `/api/cms/revalidate` is the
  // CMS's inbound publish webhook (HMAC-verified, no session, no
  // `withTenantScope`) and must stay outside this list.
  ["/api/cms/website", "website"],
  // WP Manager read models are an app-owned surface. The generic connection
  // endpoints (`/api/integrations/connections/*`, `/api/integrations/overview`)
  // are deliberately not listed here because they serve the technical
  // connection hub, which is not an app; their own role/tenant guards and the
  // `integrations` feature flag remain in force.
  ["/api/integrations/wp-manager", "integrations"],
  // The website app's own cross-manager surface: which managers this business
  // has connected, and the billing for the platform site it runs. Both belong
  // to the CMS half's `website` module — the WordPress half is gated by
  // `/api/integrations/*` above and by its own `integrations` feature flag.
  ["/api/website", "website"],
  ["/api/stock", "stock"],
];

export function moduleForApiPath(pathname: string): ModuleKey | null {
  for (const [prefix, module] of API_MODULE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return module;
  }
  return null;
}

export function moduleForPagePath(pathname: string): ModuleKey | null {
  for (const [prefix, module] of PAGE_MODULE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return module;
  }
  return null;
}
