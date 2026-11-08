# ESH-145 — Accounting café menu → Eshobe CMS

Status: implemented in Accounting; the storefront/model companion is
[eshobe-cms#196](https://github.com/hamidnoshady/eshobe-cms/issues/196)
(Linear ESH-149). The CMS default branch does **not** yet carry the café fields
below, so a live site that has not deployed #196 will reject or ignore them;
the outbox keeps the rejection visible instead of silently dropping the menu.

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
  `biza_menu_categories` and Product `terms`.

## Wire contract (companion #196)

Products carry:

- `sourceSystem: "biza_miz"`, `sourceId: "menu_item:<uuid>"` (or `item:<uuid>`
  for retail). Creates are recovered by these fields after a lost response;
  name/SKU matching is never used.
- `title`, `summary`, `sku`, `price`, `image`, `terms`, `menuOrder`.
- `_status` plus `menuAvailable` for explicit publication/availability.
  Withdrawal patches the existing product to draft/unavailable; it does not
  delete the remote row or historical order snapshots.
- `modifierGroups[]` with stable `sourceId`/`id`, `label`, effective
  `minSelect`/`maxSelect`, `isActive`, `sortOrder`, and embedded `options[]`
  with stable ids, labels, signed price deltas in the site's minor unit,
  active state and order. Add-ons are not variations.
- `trackInventory`, `inventory`, `inventoryManagedExternally`. Recipe stock is
  sent only when the connection's stock switch is on. An untracked/no-recipe
  item sends `inventory: null` and clears tracking; the sync never invents zero
  or unlimited stock.

Categories carry `sourceSystem`, `sourceId`, `name`, `description`,
`menuOrder` and the taxonomy relation. Media uploads carry `sourceSystem` and
a content-addressed `sourceId`; the local object map stores the media hash so
unchanged bytes are not re-uploaded on every retry. Legacy `image_url` is
fetched through the SSRF-safe outbound policy and uploaded as a fallback;
`image_media_id` wins when present.

## Queue behavior

- Triggers on menu/category/modifier/attachment/recipe-stock/retail-stock
  tables enqueue routing only. The drain reads current Accounting values at
  send time.
- `product.upsert`, `price.set` and `stock.set` coalesce per
  `(business, connection, kind, local product)`. Failed/dead rows keep their
  backoff; a dead row needs the owner's retry. A stale `processing` lease is
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
