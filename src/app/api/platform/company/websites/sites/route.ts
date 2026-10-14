import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { withPlatformCompany } from "@/lib/platform-company";
import { withPlatformScope } from "@/lib/platform-auth";
import type { PlatformCompanySiteOption } from "@/lib/platform-company-types";

/**
 * The internal company's real site records, per manager.
 *
 * `site_key` is a label a human types; the thing a lead form is actually
 * serving is a site row — an Eshobe CMS site (`eshobe_cms_connections`) or a
 * WordPress/WooCommerce store (`integration_connections`). Listing them here is
 * what lets a credential be bound to a real site instead of to a string that
 * only looks like one.
 */
export const GET = withPlatformScope(async (): Promise<NextResponse> => {
  const result = await withPlatformCompany(PERMISSIONS.websiteView, async (actor) => {
    const { rows: eshobe } = await query<{ id: string; site_id: string; site_domain: string; name: string }>(
      `SELECT id, site_id, site_domain,
              COALESCE(NULLIF(btrim(site_domain), ''), site_id) AS name
         FROM eshobe_cms_connections
        WHERE business_id = $1
        ORDER BY site_domain, site_id`,
      [actor.businessId],
    );
    const { rows: wordpress } = await query<{ id: string; name: string; base_url: string }>(
      `SELECT id, name, base_url
         FROM integration_connections
        WHERE business_id = $1 AND provider = 'woocommerce'
        ORDER BY name, created_at`,
      [actor.businessId],
    );
    const sites: PlatformCompanySiteOption[] = [
      ...eshobe.map((row) => ({
        id: row.id,
        provider: "eshobe" as const,
        name: row.name,
        siteId: row.site_id,
        domain: row.site_domain || null,
      })),
      ...wordpress.map((row) => ({
        id: row.id,
        provider: "wordpress" as const,
        name: row.name,
        siteId: row.id,
        domain: row.base_url,
      })),
    ];
    return sites;
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ sites: result.value });
});
