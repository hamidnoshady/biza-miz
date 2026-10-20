import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listTerms } from "@/lib/integrations/woo-taxonomy-service";
import {
  isWooAttributeTaxonomy,
  sortWooTerms,
  wooTaxonomyLabel,
  wooTermDepth,
  wooTermPath,
} from "@/lib/integrations/woo-catalogue";

/**
 * The store's taxonomy tree: categories, tags, attribute terms, and whatever
 * custom taxonomies its plugins registered.
 *
 * Attribute taxonomies (`pa_*`) come first in the ordering because they are
 * the ones that make one variation distinguishable from another — the answer
 * to "why are there twelve rows called تی‌شرت". Custom taxonomies are last
 * and labelled by slug, since a name this app has no translation for is
 * better shown than invented.
 */
export const GET = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsView);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const taxonomy = new URL(request.url).searchParams.get("taxonomy");
  const terms = await listTerms(session.businessId, id, taxonomy ?? undefined);

  const byTaxonomy = new Map<string, typeof terms>();
  for (const term of terms) {
    const list = byTaxonomy.get(term.taxonomy) ?? [];
    list.push(term);
    byTaxonomy.set(term.taxonomy, list);
  }

  const groups = [...byTaxonomy.entries()]
    .map(([slug, group]) => {
      const byId = new Map(group.map((t) => [t.remoteId, t]));
      return {
        taxonomy: slug,
        label: wooTaxonomyLabel(slug),
        isAttribute: isWooAttributeTaxonomy(slug),
        termCount: group.length,
        // How many products in the store carry *any* term of this taxonomy,
        // so a collapsed group says something more useful than its size.
        remoteCount: group.reduce((sum, t) => sum + t.remoteCount, 0),
        mappedCount: group.reduce((sum, t) => sum + t.mappedCount, 0),
        // Tree order: each parent immediately followed by its own subtree.
        terms: sortWooTerms(group).map((t) => ({
          remoteId: t.remoteId,
          parentRemoteId: t.parentRemoteId,
          name: t.name,
          slug: t.slug,
          // Indentation is a server fact here, not a guess the browser makes
          // from `parentRemoteId` alone: a grandchild is two levels in, and
          // the old single «└» could not say so.
          depth: wooTermDepth(t, byId),
          path: wooTermPath(t, byId),
          remoteCount: t.remoteCount,
          mappedCount: t.mappedCount,
        })),
      };
    })
    .sort((a, b) => {
      if (a.isAttribute !== b.isAttribute) return a.isAttribute ? -1 : 1;
      const rank = (slug: string) => (slug === "product_cat" ? 0 : slug === "product_tag" ? 1 : 2);
      return rank(a.taxonomy) - rank(b.taxonomy) || a.label.localeCompare(b.label, "fa");
    });

  return NextResponse.json({
    groups,
    total: terms.length,
    // A store with no synced tree: the catalogue sync writes it, so say so
    // rather than showing an empty box with no explanation.
    syncedAt: connection.last_catalogue_sync_at,
  });
});
