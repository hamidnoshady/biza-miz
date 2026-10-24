/**
 * Issue #944 / OVR-01 — the WordPress & WooCommerce manager's permission
 * matrix, written once and read by the page guard, the overview's buttons,
 * the WP-scoped connection list and the sync routes.
 *
 * Before this file the manager's surfaces each asked for a different key:
 * the pages for `woocommerce.view`, the connection list for
 * `integrations.view`, the sidebar's manager-state read for `website.view`,
 * and the products/orders/customers sync buttons for `integrations.manage`
 * while the content sync button asked for `woocommerce.manage`. A member
 * granted only the WP keys opened a legitimate page with an empty-looking
 * store list and four buttons that answered 403.
 *
 * The matrix below maps each *action* to the narrow WooCommerce keys that
 * name it. Where a broader technical key already granted the action before
 * (`integrations.manage` for sync), it stays accepted so nobody loses access
 * they had — but `woocommerce.view` is never widened into it; a WP viewer
 * who should run syncs is granted `woocommerce.sync`, not integration
 * administration.
 *
 *   view            open the manager; read mirrored products/orders/customers/
 *                   terms/content; read the overview counts and the WP-scoped
 *                   connection list
 *   sync            «همگام‌سازی» products/orders/customers/content now, and
 *                   the queue's retry/flush actions
 *   content_manage  edit posts/pages/media through the manager
 *   store_manage    edit products, orders, terms through the manager
 *   configure       change a connection's settings (flags, pause/resume)
 */
import { PERMISSIONS, type Permission } from "./permissions";

export type WpAbility = "view" | "sync" | "content_manage" | "store_manage" | "configure";

/** Any one of the listed keys grants the ability (`requireAnyPermission` semantics). */
export const WP_ABILITY_PERMISSIONS: Readonly<Record<WpAbility, readonly Permission[]>> = {
  view: [PERMISSIONS.woocommerceView],
  sync: [PERMISSIONS.woocommerceSync, PERMISSIONS.integrationsManage],
  content_manage: [PERMISSIONS.woocommerceManage],
  store_manage: [PERMISSIONS.woocommerceManage],
  configure: [PERMISSIONS.woocommerceConfigure, PERMISSIONS.integrationsManage],
};

/**
 * The keys that may read `GET /api/website/managers` — the sidebar's
 * "which managers does this business have" snapshot. It must be exactly the
 * set that opens the Website app (`canOpenWebsiteApp`), or a member who can
 * open the app gets an empty sidebar.
 */
export const WEBSITE_MANAGERS_READ_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.websiteView,
  PERMISSIONS.cmsView,
  PERMISSIONS.woocommerceView,
];

type PermissionBag = ReadonlySet<string> | readonly string[];

function has(bag: PermissionBag, permission: Permission): boolean {
  return Array.isArray(bag) ? (bag as readonly string[]).includes(permission) : (bag as ReadonlySet<string>).has(permission);
}

/** Whether `permissions` grants `ability` under the matrix above. */
export function canWp(permissions: PermissionBag, ability: WpAbility): boolean {
  return WP_ABILITY_PERMISSIONS[ability].some((permission) => has(permissions, permission));
}

/** The abilities a member holds, for handing to a client component as plain data. */
export function wpAbilitiesOf(permissions: PermissionBag): WpAbility[] {
  return (Object.keys(WP_ABILITY_PERMISSIONS) as WpAbility[]).filter((ability) => canWp(permissions, ability));
}
