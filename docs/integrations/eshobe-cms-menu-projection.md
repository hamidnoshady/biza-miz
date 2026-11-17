# ESH-145 — Accounting café menu → Eshobe CMS

Deploy the Eshobe CMS café-menu contract before deploying this sender. The
existing website outbox will requeue legacy café projections once.

## Ownership and scope

- Accounting owns menu content, price, recipe-derived sellable quantity and
  availability. The CMS is a projection, never a second source of truth.
- The existing `eshobe_cms_connections`, `website_product_map` and
  `website_outbox` are reused. Migration `0291_website_menu_projection.sql`
  adds connection scope, content/publication hashes, category descriptions and
  `website_menu_object_map` for auxiliary remote identities.
- Every map/outbox row names one connection. Two sites connected to the same
  business have independent marks, remote ids, category/media/modifier maps and
  queues. Disconnect disables the connection; reconnecting the same
  `(business, base_url, site_id)` reactivates it without forgetting identities.
- `menus` in the CMS is navigation. Product categories are
  `taxonomy-definitions` / `taxonomy-terms`, using the dedicated taxonomy key
  `cafe_menu_category` and Product `terms`.

## Wire contract

Biza Miz uses the site-scoped CMS café routes:

- `PUT /api/site/cafe-menu/categories/:sourceId` upserts the category by stable
  source ID with its name, description and order.
- `PUT /api/site/cafe-menu/products/:sourceId` projects each `menu_item:<uuid>`
  with category source IDs, item details and CMS modifier fields. Modifier
  prices are signed amounts in the site's minor currency unit. Stock is sent
  only when enabled. A missing recipe sends `inventory: null` with tracking off.
- `POST /api/site/cafe-menu/media/:sourceId` uploads by a content-addressed
  source ID. The object map remembers the remote file and content hash.
  `image_media_id` takes precedence over the existing `image_url` fallback.

A café item requires its own site opt-in. Withdrawal makes the existing
product a draft and marks it unavailable while retaining its historic order
references. The retail product scope still controls the retail catalogue.

## Queue behavior

- Triggers on menu/category/modifier/attachment/recipe-stock/retail-stock
  tables enqueue routing only. The drain reads current Accounting values at
  send time.
- `product.upsert`, `price.set` and `stock.set` coalesce per
  `(business, connection, kind, local product)`. Failed/dead rows keep their
  backoff after the one-time café contract upgrade; a dead row needs the owner's retry. A stale `processing` lease is
  reclaimable after five minutes.
- A per-connection advisory lock serializes remote identity recovery. Source
  ids and media hashes make a retry after a lost response idempotent.
- Dead letters are visible in the queue API and audited as
  `website.outbox.dead_lettered`; the audit payload carries
  `{ connectionId, siteId }` because `integration_audit_log.connection_id`
  references the older integration-connection table, not Eshobe connections.

## API surface

Existing routes accept an optional `connectionId` (query for GET/POST sync,
body for settings/product marks). Without it they use the first connection for
compatibility; multi-site callers must name the site:

- `GET/POST/DELETE /api/connections/website`
- `PATCH /api/connections/website/settings`
- `GET/POST /api/connections/website/products`
- `GET /api/connections/website/queue`
- `POST /api/connections/website/sync`

Unmarking a product queues a withdrawal. Deactivating an item or its category
makes the remote product unavailable. The website manager UI exposes a site
selector when more than one connection exists.

## Tests

- Pure projection/diff/coalescing: `src/lib/website/menu-projection.test.ts`,
  `sync.test.ts`.
- Payload/mock contract and lost-response recovery:
  `src/lib/website/providers/{payload,mock}.test.ts`.
- Real PostgreSQL mapping/outbox/two-site/withdrawal/reconnect:
  `integration/website-sync.integration.test.ts`,
  `integration/website-menu-projection.integration.test.ts`.
- RLS coverage for the new object map is enforced by the schema-wide checks in
  `integration/tenant-isolation.integration.test.ts`.
