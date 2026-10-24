/**
 * The WordPress & WooCommerce manager's sections.
 *
 * One of the two managers inside «مدیریت وب‌سایت» (the other is the Eshobe CMS
 * site builder). These keys are the one source of truth for what the manager
 * contains; the *URLs* they live at and their active-state rule belong to the
 * app that hosts them, `../website-routes.ts`, so that moving the manager
 * again is one prefix in one file rather than a search across the app. That
 * split is also what keeps the import one-way: this file names the sections,
 * the app's router places them.
 *
 * The manager covers everything a connected store has — commerce (products,
 * orders, customers, categories) and content (posts, pages, media), plus the
 * sync queue. The connection itself is deliberately not a section: every
 * technical connection in the product lives in the «اتصال‌های فنی» hub
 * (/settings/connections), and the old `connections` section redirects there.
 * The read/write operations are shared services in src/lib/integrations/*, so
 * the other apps that need store integration (the POS pushing stock, CRM
 * customers, Growth segments) call the same code this manager's sections
 * call; this is the *management surface*, not the only caller.
 */

export const WP_SECTION_KEYS = [
  "overview",
  "products",
  "orders",
  "customers",
  "taxonomies",
  "content",
  "media",
  "queue",
] as const;

export type WpSectionKey = (typeof WP_SECTION_KEYS)[number];

import type { Permission } from "@/lib/permissions";

/**
 * The manager's permission matrix (#944 OVR-01).
 *
 * Three action tiers, each a *narrow WooCommerce ability* — never a general
 * integrations grant, and never elevated from a weaker tier:
 *
 *   view  `woocommerce.view`    Open a section; every wp-manager read API.
 *   sync  `woocommerce.sync`    Run operational syncs (product/order/customer
 *                               pulls, the stock/price push) and act on the
 *                               queue (retry / flush / resolve review). The
 *                               connections/[id]/sync/* routes enforce this
 *                               same ability; the connection-generic
 *                               inventory push also still accepts its legacy
 *                               `integrations.manage`.
 *   edit  `woocommerce.manage`  Change store content itself. The wp-manager
 *                               content POST multiplexes post/page editing,
 *                               so its sync action rides this tier too —
 *                               splitting that route is #940's work, and the
 *                               overview's content button gates on `edit`
 *                               until then.
 *
 * Connection *configuration* (creating a connection, touching credentials)
 * deliberately stays outside this matrix, in the «اتصال‌های فنی» hub under
 * `integrations.manage` / `woocommerce.configure`: running a store day to
 * day must not require the keys to rewire it. The one bridge is listing:
 * `GET /api/integrations/connections?provider=woocommerce` accepts
 * `woocommerce.view`, so a member who may open this manager can see the
 * stores it manages; the unfiltered cross-provider list still requires
 * `integrations.view`. (The list payload carries no secrets — see
 * `mapConnection`.)
 *
 * The tiers are uniform across sections today; the key parameter is kept so
 * a future split (say, the queue demanding more than the overview) changes
 * the rules here rather than every call site. UI gating (`canSync`/`canEdit`
 * in the store context) mirrors these functions — the API routes re-check
 * the same permissions, so a disabled button is a courtesy, not the fence.
 */

/**
 * Role gate. Like the integrations panel this manager supersedes, everything
 * here is owner/manager work — it writes to a live shopfront and sees every
 * customer record. Cashiers see the launcher but land on the dashboard.
 */
export function canViewWpSection(permissions: ReadonlySet<Permission>, _key: WpSectionKey): boolean {
  return permissions.has("woocommerce.view");
}

/** May this member run syncs and queue actions for the section? (`woocommerce.sync`) */
export function canSyncWpSection(permissions: ReadonlySet<Permission>, _key: WpSectionKey): boolean {
  return permissions.has("woocommerce.sync");
}

/** May this member change store content from the section? (`woocommerce.manage`) */
export function canEditWpSection(permissions: ReadonlySet<Permission>, _key: WpSectionKey): boolean {
  return permissions.has("woocommerce.manage");
}

/** The write-side tiers, resolved once per request for UI gating. */
export interface WpSectionCaps {
  /** `woocommerce.sync` — run syncs and queue actions. */
  canSync: boolean;
  /** `woocommerce.manage` — change store content. */
  canEdit: boolean;
}
