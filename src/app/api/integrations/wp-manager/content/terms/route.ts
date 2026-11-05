import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { wooClientFor } from "@/lib/integrations/connections-service";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import {
  MAX_PICKER_TERMS,
  WP_TAXONOMY_ENDPOINTS,
  normaliseWpTerms,
  pluginSupportsPostTaxonomies,
  postTermsFromCapabilities,
  type WpTaxonomy,
  type WpTermOption,
} from "@/lib/wp-content-taxonomies";

/**
 * The categories and tags a post's editor may offer (issue #1215, P2‑5).
 *
 * Two sources, one shape, and one honest gap:
 *
 *  - **REST mode** reads `wp/v2/categories` and `wp/v2/tags` live, because the
 *    app holds keys for the site.
 *  - **Plugin mode** cannot reach the site at all, so it reads the list the
 *    plugin reported in its last handshake — capped there, since a store with
 *    thousands of tags must not push thousands of entries on every handshake.
 *  - A plugin that never reported them answers `unsupported`, and the editor
 *    says so instead of drawing an empty picker that looks like "no
 *    categories exist".
 */
const TAXONOMIES: WpTaxonomy[] = ["category", "post_tag"];

async function liveTerms(
  connection: Parameters<typeof wooClientFor>[0],
  taxonomy: WpTaxonomy,
): Promise<{ terms: WpTermOption[]; failed: boolean }> {
  try {
    const client = wooClientFor(connection);
    const page = await client.wpListPage(WP_TAXONOMY_ENDPOINTS[taxonomy], {
      page: 1,
      per_page: Math.min(100, MAX_PICKER_TERMS),
      orderby: "count",
      order: "desc",
      hide_empty: false,
    });
    return { terms: normaliseWpTerms(page.items), failed: false };
  } catch {
    // A site whose key cannot read terms is not an error the owner can fix from
    // here; the editor shows «فهرست در دسترس نیست» and keeps the current terms.
    return { terms: [], failed: true };
  }
}

export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceView);
  if (error) return error;

  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId") ?? "";
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });

  const connection = await getAccessibleConnection(session, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (connection.link_mode === "plugin") {
    if (!pluginSupportsPostTaxonomies(connection.plugin_capabilities)) {
      return NextResponse.json({ categories: [], tags: [], unsupported: true });
    }
    return NextResponse.json({
      categories: postTermsFromCapabilities(connection.plugin_capabilities, "category"),
      tags: postTermsFromCapabilities(connection.plugin_capabilities, "post_tag"),
    });
  }

  const [categories, tags] = await Promise.all(TAXONOMIES.map((taxonomy) => liveTerms(connection, taxonomy)));
  return NextResponse.json({
    categories: categories.terms,
    tags: tags.terms,
    // Partial is possible: one collection may be readable while the other is not.
    ...(categories.failed || tags.failed ? { partial: true } : {}),
  });
});
