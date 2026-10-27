import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requireAnyPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { wooClientFor } from "@/lib/integrations/connections-service";
import {
  listTaxonomyStates,
  listTerms,
  syncTaxonomyTree,
  taxonomyGroupStats,
  type TermRow,
} from "@/lib/integrations/woo-taxonomy-service";
import { isPluginJobUnsupportedError, PLUGIN_JOB_UNSUPPORTED } from "@/lib/integrations/plugin-job-guard";
import { enqueuePluginExport } from "@/lib/integrations/plugin-service";
import { pluginSupportsJobType } from "@/lib/integrations/plugin-capabilities";
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
 *
 * Issue #939 TAX-05 — the permission this route checks used to be
 * `integrations.view` while every page of the WP Manager that renders this
 * data stands behind `woocommerce.view`: two independent keys, so a member
 * could see the screen and get a 403 from its own API, or hold the API key
 * with no screen to use it on. The two surfaces this read serves are the WP
 * Manager (`woocommerce.view`, checked by wp-guard at the page) and the
 * technical-connections hub (`integrations.view`, the key every other
 * connection read API uses), so either one is accepted here — enforced on
 * every request regardless of which menu the caller can see. Tenant ownership and
 * live branch scope come from `getAccessibleConnection(session, …)`:
 * an inaccessible connection is a 404, not a 403.
 */
export const GET = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireAnyPermission(
    PERMISSIONS.woocommerceView,
    PERMISSIONS.integrationsView,
  );
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const taxonomy = new URL(request.url).searchParams.get("taxonomy");
  const [terms, states, stats] = await Promise.all([
    listTerms(session.businessId, id, taxonomy ?? undefined),
    listTaxonomyStates(session.businessId, id),
    taxonomyGroupStats(session.businessId, id),
  ]);

  const byTaxonomy = new Map<string, TermRow[]>();
  for (const term of terms) {
    const list = byTaxonomy.get(term.taxonomy) ?? [];
    list.push(term);
    byTaxonomy.set(term.taxonomy, list);
  }
  const stateByTaxonomy = new Map(states.map((state) => [state.taxonomy, state]));
  const statsByTaxonomy = new Map(stats.groups.map((group) => [group.taxonomy, group]));

  // TAX-14: a group exists when the store has *terms* for it OR when the
  // mirror has a *state row* for it — a taxonomy that is legitimately empty,
  // or whose last read failed, used to vanish from this screen entirely
  // because groups were built only from returned term rows. Now an empty
  // group says «empty», a failed one says «failed, and here is the error»,
  // and neither is indistinguishable from "never discovered".
  const allTaxonomies = new Set([...byTaxonomy.keys(), ...stateByTaxonomy.keys()]);
  const selected = taxonomy ? [...allTaxonomies].filter((slug) => slug === taxonomy) : [...allTaxonomies];

  const groups = selected
    .map((slug) => {
      const group = byTaxonomy.get(slug) ?? [];
      const state = stateByTaxonomy.get(slug) ?? null;
      const groupStats = statsByTaxonomy.get(slug) ?? null;
      const byId = new Map(group.map((t) => [t.remoteId, t]));
      return {
        taxonomy: slug,
        label: wooTaxonomyLabel(slug),
        isAttribute: isWooAttributeTaxonomy(slug),
        termCount: group.length,
        // TAX-08, honest numbers: `mappedCount` is UNIQUE mapped products
        // carrying any term of this taxonomy (the old figure summed per-term
        // counts, so one product in three categories counted three times
        // under a chip labelled «محصول همگام‌شده»); `assignmentCount` is the
        // membership-row total, labelled as assignments; `remoteCount` stays
        // the sum of the store's own per-term counts — memberships on the
        // store's side, which is what a term's «در فروشگاه» number means.
        remoteCount: group.reduce((sum, t) => sum + t.remoteCount, 0),
        mappedCount: groupStats?.mappedProducts ?? 0,
        assignmentCount: groupStats?.assignments ?? 0,
        // Per-taxonomy truth (TAX-04): synced / truncated / failed / pending.
        // Terms without a state row predate the state table; they are honest
        // as `pending` until the next sync stamps them.
        status: state?.status ?? "pending",
        lastError: state?.lastError ?? null,
        lastSyncedAt: state?.lastSyncedAt ?? null,
        restBase: state?.restBase || null,
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

  // The last moment ANY taxonomy of this store was successfully mirrored —
  // per-group stamps live on the groups; this is the screen-level one.
  const lastTaxonomySyncAt = states.reduce<string | null>(
    (latest, state) =>
      state.lastSyncedAt && (!latest || state.lastSyncedAt > latest) ? state.lastSyncedAt : latest,
    null,
  );

  return NextResponse.json({
    groups,
    total: terms.length,
    totals: {
      groups: groups.length,
      terms: terms.length,
      // Whole-connection unique products / assignment rows — NOT the sum of
      // the per-group numbers, which would double-count a product that sits
      // in both a category and a tag.
      mappedProducts: stats.totals.mappedProducts,
      assignments: stats.totals.assignments,
    },
    // A store with no synced tree: the catalogue sync writes it, so say so
    // rather than showing an empty box with no explanation.
    syncedAt: connection.last_catalogue_sync_at,
    lastTaxonomySyncAt,
  });
});

/**
 * «همگام‌سازی از وب‌سایت» — re-read the taxonomy tree FROM THE STORE.
 *
 * Issue #939 TAX-12: the screen's only button used to be a GET of this very
 * route — a "refresh" that re-read the local mirror and could never show
 * anything new. This is the missing remote action, honest per connection
 * mode: REST pulls the tree now and returns the per-taxonomy outcomes;
 * plugin mode cannot be dialled, so it queues the job and says `queued`
 * (the queue screen at /websites/wp/queue shows it land).
 */
export const POST = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  // Sync is an operation, not a read: `woocommerce.sync` (the WP Manager's
  // own action key, as used by the queue route) or `integrations.manage`
  // (the connections hub's action key, as used by the products sync route).
  const { session, error } = await requireAnyPermission(
    PERMISSIONS.woocommerceSync,
    PERMISSIONS.integrationsManage,
  );
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!connection.sync_products) {
    return NextResponse.json({ ok: false, error: "sync_products_disabled" }, { status: 409 });
  }
  if (connection.status === "paused") {
    return NextResponse.json({ ok: false, error: "connection_paused" }, { status: 409 });
  }

  if (connection.link_mode === "plugin") {
    // A taxonomy-only sweep when the plugin understands it; otherwise the
    // full catalogue export, which carries the taxonomy snapshots with it.
    // Queueing a job type the plugin never advertised would strand the row
    // pending forever — the lease filters by capability.
    const jobType = pluginSupportsJobType(connection.plugin_capabilities, "taxonomy_export")
      ? ("taxonomy_export" as const)
      : ("catalogue_export" as const);
    try {
      await enqueuePluginExport(session.businessId, id, jobType);
    } catch (err) {
      // Neither export type advertised: refuse rather than strand the row (#944 / OVR-08).
      if (isPluginJobUnsupportedError(err)) return NextResponse.json({ ok: false, error: PLUGIN_JOB_UNSUPPORTED }, { status: 409 });
      throw err;
    }
    return NextResponse.json({ ok: true, queued: true, jobType });
  }

  let client;
  try {
    client = wooClientFor(connection);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 409 });
  }
  try {
    const outcome = await syncTaxonomyTree(session.businessId, id, client);
    // 200 even when partial: the run happened, and the per-taxonomy results
    // ARE the answer. A total failure (nothing landed) is a 502 so the UI
    // can style it as an error rather than a summary.
    return NextResponse.json({ ok: true, queued: false, ...outcome }, { status: outcome.status === "failed" ? 502 : 200 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
