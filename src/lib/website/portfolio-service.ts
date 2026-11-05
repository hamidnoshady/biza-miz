/**
 * The tenant-scoped *site portfolio* read model behind «مدیریت وب‌سایت»'s home
 * (issue #1215 / P1‑1).
 *
 * One CMS site plus one entry for **each** non-deleted WooCommerce connection,
 * assembled from a fixed number of local reads — never one remote call per
 * site. The rules that turn those rows into cards live in `site-portfolio.ts`;
 * this file only reads.
 *
 * Three things it deliberately does **not** do:
 *
 *  - it never calls the CMS or a store, so a down shop cannot make the app home
 *    slow (the connection health it shows is the *recorded* health, with the
 *    timestamp that says how old it is);
 *  - it never turns a failed or refused read into an empty list — each half is
 *    its own `ok | denied | error` part, because «شما هیچ سایتی ندارید» on a
 *    server error is the lie this epic exists to remove;
 *  - it never widens access: the WooCommerce half is read only for a member who
 *    holds `woocommerce.view` (and only for the branches they are assigned to),
 *    the CMS half only for `cms.view`.
 *
 * DB-touching, so per repo convention it is exercised through the screen and
 * the pure rules beside it rather than unit-tested directly.
 */
import type { SessionPayload } from "@/lib/auth-edge";
import type { Permission } from "@/lib/permissions";
import { summarizeQueueCounts } from "@/lib/integrations/wp-manager-service";
import { listAccessibleConnections } from "@/lib/integrations/connection-access";
import { getWebsiteConnection } from "@/lib/website/connection-service";
import { summarizeWebsiteQueue } from "@/lib/website/catalog-service";
import { canWp } from "@/lib/wp-access";
import { query } from "@/lib/db";
import {
  cmsSiteState,
  isoTimestamp,
  siteHost,
  siteUrl,
  storeLastAppliedAt,
  storeSiteState,
  storeVerification,
  type CmsSiteCard,
  type PortfolioPart,
  type SitePortfolioState,
  type StoreSiteCard,
} from "@/lib/website/site-portfolio";

type PermissionBag = ReadonlySet<Permission> | ReadonlySet<string>;

async function readCmsCard(businessId: string): Promise<CmsSiteCard | null> {
  const connection = await getWebsiteConnection(businessId);
  if (!connection) return null;

  // The site's own push queue (`website_outbox`, migration 0136) and the mark
  // the owner set on products. Both are local counts; nothing here dials the
  // CMS.
  const [queue, applied] = await Promise.all([
    summarizeWebsiteQueue(businessId),
    query<{ synced_products: string; last_sent_at: unknown }>(
      `SELECT (SELECT count(*) FROM website_product_map
                WHERE business_id = $1 AND sync_enabled)::text AS synced_products,
              (SELECT max(sent_at) FROM website_outbox
                WHERE business_id = $1 AND status = 'sent') AS last_sent_at`,
      [businessId],
    ),
  ]);
  const row = applied.rows[0];

  return {
    kind: "cms",
    id: connection.id,
    domain: connection.siteDomain || null,
    state: cmsSiteState({
      status: connection.status,
      lastError: connection.lastError,
      lastCheckedAt: connection.lastCheckedAt,
    }),
    lastCheckedAt: isoTimestamp(connection.lastCheckedAt),
    lastAppliedAt: isoTimestamp(row?.last_sent_at),
    syncedProducts: Number(row?.synced_products ?? 0),
    // A `dead` job is the site's failed work exactly as it is the store's: it
    // will not move again without a person.
    work: { pending: queue.pending, failed: queue.failed + queue.dead },
  };
}

/** Local mirrored counts for every store in one query, keyed by connection. */
async function readStoreCounts(businessId: string, ids: readonly string[]) {
  if (ids.length === 0) {
    return { mappings: new Map<string, { products: number; orders: number }>(), queue: new Map<string, { pending: number; failed: number }>() };
  }
  const [mappingRows, queueRows] = await Promise.all([
    query<{ connection_id: string; entity_type: string; n: string }>(
      `SELECT connection_id, entity_type, count(DISTINCT remote_id)::text AS n
         FROM integration_mappings
        WHERE business_id = $1 AND connection_id = ANY($2::uuid[])
          AND entity_type IN ('product', 'order')
        GROUP BY connection_id, entity_type`,
      [businessId, ids],
    ),
    // The Queue page's own status set (#944 / OVR-03), so a card's «کار معطل»
    // and the queue screen can never disagree about what is waiting.
    query<{ connection_id: string; source: string; status: string; n: string }>(
      `SELECT connection_id, 'outbox' AS source, status, count(*)::text AS n
         FROM integration_outbox_events
        WHERE business_id = $1 AND connection_id = ANY($2::uuid[])
        GROUP BY connection_id, status
       UNION ALL
       SELECT connection_id, 'inbox' AS source, status, count(*)::text AS n
         FROM integration_webhook_events
        WHERE business_id = $1 AND connection_id = ANY($2::uuid[])
          AND status IN ('pending', 'failed', 'deferred', 'processed')
        GROUP BY connection_id, status`,
      [businessId, ids],
    ),
  ]);

  const mappings = new Map<string, { products: number; orders: number }>();
  for (const row of mappingRows.rows) {
    const entry = mappings.get(row.connection_id) ?? { products: 0, orders: 0 };
    if (row.entity_type === "product") entry.products = Number(row.n);
    else entry.orders = Number(row.n);
    mappings.set(row.connection_id, entry);
  }

  const outbox = new Map<string, Map<string, number>>();
  const inbox = new Map<string, Map<string, number>>();
  for (const row of queueRows.rows) {
    const target = row.source === "inbox" ? inbox : outbox;
    const statuses = target.get(row.connection_id) ?? new Map<string, number>();
    statuses.set(row.status, Number(row.n));
    target.set(row.connection_id, statuses);
  }
  const queue = new Map<string, { pending: number; failed: number }>();
  for (const id of ids) {
    const summary = summarizeQueueCounts(outbox.get(id) ?? new Map(), inbox.get(id) ?? new Map());
    queue.set(id, { pending: summary.inFlight, failed: summary.attention });
  }
  return { mappings, queue };
}

async function readStoreCards(session: SessionPayload): Promise<StoreSiteCard[]> {
  const connections = (await listAccessibleConnections(session)).filter(
    (connection) => connection.provider === "woocommerce",
  );
  const { mappings, queue } = await readStoreCounts(
    session.businessId,
    connections.map((connection) => connection.id),
  );

  return connections.map((connection) => {
    const stateInput = {
      status: connection.status,
      linkMode: connection.linkMode,
      transportState: connection.transportHealth?.state ?? null,
      lastSuccessfulTestAt: connection.lastSuccessfulTestAt,
      lastSyncAt: connection.lastSyncAt,
      lastCatalogueSyncAt: connection.lastCatalogueSyncAt,
      lastOrderSyncAt: connection.lastOrderSyncAt,
      lastCustomerSyncAt: connection.lastCustomerSyncAt,
      lastContentSyncAt: connection.lastContentSyncAt,
      lastPluginSeenAt: connection.lastPluginSeenAt,
    };
    const verification = storeVerification(stateInput);
    const counts = mappings.get(connection.id) ?? { products: 0, orders: 0 };
    return {
      kind: "woocommerce" as const,
      id: connection.id,
      name: connection.name,
      domain: siteHost(connection.baseUrl),
      url: siteUrl(connection.baseUrl),
      linkMode: connection.linkMode,
      state: storeSiteState(stateInput),
      lastVerifiedAt: verification.at,
      verificationSource: verification.source,
      lastAppliedAt: storeLastAppliedAt(stateInput),
      products: counts.products,
      orders: counts.orders,
      work: queue.get(connection.id) ?? { pending: 0, failed: 0 },
    };
  });
}

async function readPart<T>(read: () => Promise<T>): Promise<PortfolioPart<T>> {
  try {
    return { status: "ok", value: await read() };
  } catch {
    // The screen renders a retry for this half; it must not look like «empty»
    // and it must not take the other half down with it.
    return { status: "error" };
  }
}

/**
 * Assemble the app home's site portfolio for one session.
 *
 * `permissions` comes from `memberAccessFor(session)` — the same bag the layout
 * and the sidebar use; the API stays authoritative for every action, this only
 * decides which cards exist for this member.
 */
export async function websitePortfolioState(
  session: SessionPayload,
  permissions: PermissionBag,
): Promise<SitePortfolioState> {
  const canReadCms = permissions.has("cms.view");
  const canReadStores = canWp(permissions, "view");

  const [cms, stores] = await Promise.all([
    canReadCms ? readPart(() => readCmsCard(session.businessId)) : Promise.resolve<PortfolioPart<CmsSiteCard | null>>({ status: "denied" }),
    canReadStores ? readPart(() => readStoreCards(session)) : Promise.resolve<PortfolioPart<StoreSiteCard[]>>({ status: "denied" }),
  ]);

  return { readAt: new Date().toISOString(), cms, stores };
}
