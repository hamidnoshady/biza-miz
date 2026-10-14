/**
 * The CRM app's section routing.
 *
 * These keys are the one source of truth for the app's menu (`crm-nav.ts`
 * labels them), for the server-side permission gate on each page, and for the
 * sidebar's "you are here". A section that exists as a route but not as a key
 * is a page nobody can find.
 *
 * **The keys and their permissions moved to `src/lib/crm-permissions.ts`**, for
 * one concrete reason: `crm-routes.ts` lives under a `(app)` page directory, so
 * an API route cannot import it, and the section permission table is exactly
 * what a route guard has to agree with. Keeping the table here meant the API
 * restated it — and the two statements drifted, which is how the case-delete
 * button came to be drawn on a permission the endpoint does not accept. What is
 * left in this file is what only a route can know: hrefs, and which path
 * belongs to which section.
 */

export { CRM_SECTION_KEYS, type CrmSectionKey } from "@/lib/crm-permissions";

import {
  canOpenCrm as canOpenCrmWith,
  canViewCrmSection as canViewCrmSectionWith,
  crmFallbackSection,
  type CrmSectionKey as CrmSectionKeyType,
} from "@/lib/crm-permissions";
import type { Permission } from "@/lib/permissions";

/** The route for a section. The overview is the app root; the rest nest under it. */
export function crmSectionHref(key: CrmSectionKeyType): string {
  return key === "overview" ? "/crm/overview" : `/crm/${key}`;
}

/** The CRM's own settings page — never the platform settings page. */
export const CRM_SETTINGS_HREF = "/crm/settings";

/** The CRM's decision log — who moved what, and why. */
export const CRM_AUDIT_HREF = "/crm/audit";

/** The route of one customer's 360° file. */
export function crmCustomerHref(customerId: string): string {
  return `/crm/persons/${customerId}`;
}

/**
 * Where a won deal's settled sale actually lives. The orders screen opens a
 * given order straight away on `?order=<id>` (see `accounting/orders/page.tsx`
 * and `OrdersList`'s `initialOrderId`) — this is the one other place in the
 * app a deal's `orderId` is allowed to point, since the pipeline itself posts
 * nothing.
 */
export function crmDealOrderHref(orderId: string): string {
  return `/accounting/orders?order=${orderId}`;
}

/**
 * The section permission table lives in `src/lib/crm-permissions.ts` because
 * the API routes need it too, and a route guard may not import from a
 * `(app)` page directory. These two are thin re-exports so every existing
 * caller keeps working and no screen grows a second copy of the rule.
 */
export function canViewCrmSection(
  permissions: ReadonlySet<Permission>,
  key: CrmSectionKeyType,
): boolean {
  return canViewCrmSectionWith(permissions, key);
}

export function canOpenCrm(permissions: ReadonlySet<Permission>): boolean {
  return canOpenCrmWith(permissions);
}

export function crmFallbackHref(permissions: ReadonlySet<Permission>): string {
  const section = crmFallbackSection(permissions);
  return section ? crmSectionHref(section) : "/dashboard";
}

/**
 * Whether a dashboard path is a given section — the sidebar's idea of "you are
 * here". The overview is the app root, so it matches exactly and nothing else;
 * every other section also owns what nests under it. A customer's file
 * (`/crm/persons/<id>`) belongs to Contacts (`directory`) for navigation, not
 * to a permanent detail-page sidebar entry.
 *
 * The old `customers` path is kept as an alias for `persons` so bookmarks and
 * external links survive the rename — both the current `/crm/customers/*` and
 * the pre-move `/dashboard/crm/customers/*`, which middleware redirects here.
 */
export function isCrmSectionPathname(pathname: string, key: CrmSectionKeyType): boolean {
  const href = crmSectionHref(key);
  if (key === "overview") return pathname === href;
  const isPersonDetail =
    pathname === "/crm/persons" ||
    pathname.startsWith("/crm/persons/") ||
    pathname === "/crm/customers" ||
    pathname.startsWith("/crm/customers/");
  // A person file is reached from Contacts; it is not a second permanent
  // sidebar destination. Keep the owning Contacts row current on both the
  // canonical and compatibility detail URLs.
  if (key === "directory") {
    return pathname === href || pathname.startsWith(`${href}/`) || isPersonDetail;
  }
  if (key === "persons") return isPersonDetail;
  return pathname === href || pathname.startsWith(`${href}/`);
}
