# Phase 38 — the WooCommerce catalogue, and operating the store from the app

> Filed as **38** because 37 is already promised elsewhere in the docs (the
> project/owner/budget dimension, `src/lib/ai-projects.ts:7`). It closes the
> gap GitHub issue **#118** left open after Phase 23b: the integration worked
> for a café with twenty *simple* products and quietly broke on every other
> shop. It is two halves — **the catalogue a store actually has**, and
> **the operations an owner actually asks for** — on one new migration
> (`0120_woocommerce_catalogue_ops.sql`).

## Why

Five failures, all real, all invisible from the dashboard:

- **`products` never returned variations.** `/wp-json/wc/v3/products` excludes
  them by design; a variant shop's sellable rows simply did not exist as far as
  the sync was concerned.
- **Order lines ignored `variation_id`.** A line for «تی‌شرت / مشکی / L»
  resolved to the parent — which is a container with no stock and no price — so
  the sale relieved nothing and posted no COGS.
- **The webhook and the plugin disagreed.** `WC_Order_Item_Product::get_product()`
  returns the *variation*, so for the same order a webhook sent `product_id` =
  parent + `variation_id` = child while the plugin sent `product_id` = the
  variation. One sale, two different local rows.
- **Nothing knew the store's own taxonomy.** Categories, tags, brands and
  `pa_*` attributes arrived as free text on the product and were thrown away —
  so there was no way to ask «which brand sells best».
- **The only thing the app could push was a number.** Phase 23b's outbox could
  set stock and set price, both automatically. Marking an order completed,
  refunding two lines, or putting a product on sale meant leaving the app.

And one scheduling failure that made all of the above slow to notice: a single
cron hook did push, pull and sweep together, so a broken row consumed a slot in
every five-minute batch until it had failed eight times inside forty minutes.

## Shape

### The catalogue (`src/lib/integrations/woo-catalogue.ts`, `woocommerce-client.ts`)

`woocommerce-client.ts` now speaks both namespaces — `wooApiUrl` for `wc/v3`
and `wpApiUrl` for `wp/v2` — and adds the paged reads Phase 23b never had:
`listVariations`, `listCategories`, `listTags`, `listTerms`, `listTaxonomies`,
`listAttributes`, `listAttributeTerms`, `updateAt`, `updateOrder`,
`listRefunds` / `listOrderRefunds` / `createRefund`. Pagination treats
`X-WP-TotalPages` as authoritative and falls back to
`items.length > 0 ? page : 0`.

The type matrix is a pure function of `product.type`:

| Woo type | Local row | Stock tracked |
|---|---|---|
| `simple`, `bundle`, `composite`, `external`¹, anything unknown | sellable `item` | yes (not `external`) |
| `variable`, `grouped` | `variant_parent` | no |
| `variation` | `variant_child` under its parent | yes |

¹ `external` is sellable but its stock lives on another site. An unknown type
defaults to sellable `simple` and is **never skipped** — a shop on an extension
that adds `booking` or `subscription` should degrade to "sells like a simple
product", not to "invisible".

`wooUpdatePath(remoteId, parentRemoteId)` returns
`products/{parent}/variations/{id}` when there is a parent, which is the only
path WooCommerce accepts for a variation.

`resolveWooOrderLine` is the decision the old code got wrong. A variation is
used only when `variationId > 0 && variationId !== productId`, and it reports
*how* it got there: `via: 'variation' | 'product' | 'parent_fallback' | 'none'`.
Only `variation` and `product` relieve stock and post COGS; a `parent_fallback`
against a container creates a `variant_child` stub **in the same transaction**,
so the sale is never dropped on the floor — it is recorded against a placeholder
the owner can see and fix.

### Taxonomies (`woo-taxonomy-service.ts`, migration 0120)

`integration_woo_terms` mirrors the store's trees keyed by remote id
(`product_cat`, `product_tag`, `pa_colour`, `brand`, …) and
`integration_woo_product_terms` is the join. Both are tenant-scoped with RLS in
the same migration. Sync is **replace, not merge**: a term deleted in the store
must not linger in the app's idea of the catalogue.

The `menu_categories` bridge is a *separate* opt-in (`sync_categories`,
default **off**, mapped as `entity_type = 'category'`). Mirroring a store's
taxonomy and restructuring the till's menu are different decisions with
different blast radii, and an F&B owner who connects a WooCommerce shop for
delivery does not expect their kitchen menu rewritten.
`menu_categories` has no unique constraint on `(location_id, name)`, so
`ensureMenuCategory` SELECTs by name before inserting — `ON CONFLICT DO NOTHING
RETURNING id` silently returns zero rows there.

### Operating the store (`woo-ops-service.ts`, `outbox-service.ts`)

Every operation goes through the existing `integration_outbox_events` queue.
Why not a direct call: half the stores this app connects to are reachable only
from the inside. In plugin mode the app holds **no credentials** for the store
and cannot dial it at all — the WordPress plugin pulls these rows and applies
them. Routing through the outbox is what makes «تغییر وضعیت سفارش» behave
identically whether the store faces the internet or sits behind a firewall, and
what gives it the retry, the backoff and the dead-letter trail.

Three event types join `product_stock` and `product_price`: `product_update`,
`order_status`, `refund_create`. `PRODUCT_UPDATE_FIELDS` is a closed list of
eight — `name`, `regular_price`, `sale_price`, `stock_quantity`,
`manage_stock`, `status`, `description`, `short_description`. `type`,
`parent_id`, `sku`, `attributes` and `categories` are all writable over REST
and all refused: one mis-sent `type` orphans every variation a product has.

**Refunds never touch the gateway.** `api_refund` is forced false in
`sanitizeRefund` and again in `applyOutboundEvent`. Refunding a card is
irreversible and happens on someone else's money; this app records that a
refund was agreed, it does not move funds.

`parentRemoteId` rides on the outbox row as `payload.__parentRemoteId`
(reserved, stripped before send); the plugin's lease falls back to
`integration_mappings.last_pushed_payload->>'remoteParentId'` when a plugin
that predates this phase never sent it.

### Plugin mode (`plugin-service.ts`, the WordPress plugin)

The plugin handshake now advertises `jobTypes`, so the app can tell what a
given site can apply. `apply_job` **acks an unknown type as done, not failed** —
an older plugin must not dead-letter work it cannot understand.

The scheduling answer the user chose is **split**: three hooks instead of one.

| Hook | Default | Does |
|---|---|---|
| `pos_connector_sync` | 5 min | handshake → push queue → lease + apply jobs |
| `pos_connector_resync_orders` | 15 min | re-queue orders modified in `resync_orders_days` (default 7, capped at 200 per sweep) |
| `pos_connector_resync_products` | hourly | full catalogue re-export, then `run()` |

Order inside `run()` matters: handshake **first** (it refreshes the sync toggles
the push honours), push **before** pull.

Exponential backoff (`class-pos-queue.php`): a new `available_at` column and a
`due_lookup` key make `due()` = `pending AND available_at <= now`, and
`fail()` sets `available_at = now + min(3600, 60 × 2^attempts)` with `attempts`
read *before* the increment, so the first failure waits one minute. Without it,
one broken row ate a slot in every batch.

### The plugin's own catalogue fix

`export_products()` is now two passes: **all** `product` posts with **no**
`type` filter (1.0.x passed `array('simple','variable')` and silently dropped
grouped, external and every extension type), then `type => 'variation'`.
Parents are enqueued **before** children so the app never sees an orphan.

Children are **not** embedded in the parent payload. A 100-SKU product would
mean 100 `get_product` calls inside one HTTP request — a timeout risk — and the
embedded copy is stale the moment one variation changes. Each variation is its
own event; the parent carries only `variation_ids`.

Order lines now emit both ids with WooCommerce's own names, deriving
`product_id` from `get_parent_id()` when a line item lacks it. Refund
quantities are negative in WooCommerce, so `refund_payload()` emits magnitudes.
Empty variation attribute values become «هر کدام», never a blank label.

### WP-CLI (`class-pos-cli.php`)

`wp pos-connector status|sync|test|export <products|orders|customers>
[--days=N]`, all gated on `enabled` + base URL + token. Safe to run every
minute: the queue dedups on `(topic, remote_id)` and the app on delivery id.
`status` prints the queue including the deferred count, all three
`wp_next_scheduled` times, and a warning when `DISABLE_WP_CRON` is off.

### The settings screen

A scheduling form posts `resync_orders_schedule` / `resync_orders_days`
(clamped 1..365) / `resync_products_schedule`, then re-arms each hook — the
re-arm matters because `wp_schedule_event()` ignores a changed interval on an
already-scheduled hook. Per-hook next-run rows, last-sweep timestamps, the
deferred count, manual «ارسال کل کاتالوگ» / «ارسال سفارش‌های اخیر» buttons, and
a «کرون واقعی» box with a copyable
`*/5 * * * * wp --path=<ABSPATH> pos-connector sync`.

### The app side

New API routes under `/api/integrations/connections/[id]/`: `sync/orders`,
`catalogue`, `taxonomies`, `store/orders` (GET + POST status/refund),
`store/products` (POST). Four new sections in the WooCommerce panel —
catalogue, taxonomies, store orders, sync settings — one open at a time per
store, sharing `format.ts`'s Shamsi `formatDateTime`.

`storeOrdersFor` reads `integration_mappings` with a `LEFT JOIN LATERAL` on the
latest `integration_webhook_events` row per order, so plugin mode needs **zero**
store round-trips.

## Load-bearing decisions

- **A container is skipped in F&B, and this is unresolved.** `menu_items` has
  no parent/child concept at all, so for a `food_service` business "all product
  types" still has no answer — a `variable` product has nowhere to go. It is
  skipped rather than half-mirrored; a decision is needed before this is
  complete, and it wants a schema change, not a mapping tweak.
- **`resolveWooOrderLine` returns `via` rather than a bare id.** The two
  inbound shapes (webhook and plugin) are *distinguishable on purpose*, because
  silently folding them together is what produced two rows for one sale.
- **Prices are strings, never numbers.** WooCommerce rejects a JSON number for
  price, and a float would round an amount the owner typed by hand.
- **Replace, not merge, on the taxonomy mirror.**
- **A scheduled pull is REST-only** (`link_mode === 'rest_api' &&
  auto_pull_orders && sync_orders`). In plugin mode the plugin is the scheduler.
- **The plugin's heartbeat and the app's cron do not overlap.** The app's
  scheduled `syncOrders` exists for sites with no plugin; where a plugin is
  installed, it pulls.

## Exit criteria

Checked off:

- [x] `products` variations, categories, tags, attributes and arbitrary
      taxonomies are fetched, paged, and mirrored (`integration_woo_terms`).
- [x] Every product type lands in the right local row; unknown types degrade
      to sellable rather than disappearing.
- [x] An order line for a variation relieves *that variation's* stock and posts
      COGS against *its* cost basis.
- [x] The webhook shape and the plugin shape resolve to the same row.
- [x] Order status push, refund push and product field push all route through
      the outbox, and therefore work in plugin mode.
- [x] Three independently scheduled, independently retryable cron hooks, each
      visible and re-armable in WP admin.
- [x] A reconciliation view: per-hook next run, last sweep, deferred count,
      and manual re-send of the catalogue or recent orders.

Not yet:

- [ ] The F&B container question above — what `variable` and `grouped` mean for
      a business whose item model has no parent/child.
- [ ] Attribute *creation* from the app (the mirror is read-only; a term the
      store does not have cannot yet be invented here).

## Duplicate SKUs: one remote product, one local item (dashboard audit F13)

The audit found two identical rows for one SKU, and a second pair whose
quantities were five and six. Product creation was check-then-insert: the
mapping was read, found missing, and an item inserted, with nothing
serialising two deliveries of the *same new* product. WooCommerce fires
`product.created` and `product.updated` for one save (two delivery ids, so the
inbox does not dedupe them), and the plugin queue, the manual catalogue pull and
an order's variation stub all reach the same code. Both deliveries inserted an
item, and the later mapping upsert (`ON CONFLICT … DO UPDATE SET local_id`)
re-pointed the mapping at its own row. The first item stayed behind unmapped:
same name, same SKU, and a stock snapshot frozen at the instant it was written —
every later sync updates only the mapped twin. A second variant of the bug made
one stub per *line* when an order carried the same unmapped variation twice.

Creation now runs under `lockRemoteIdentity` (`mapping-service.ts`, a
transaction-scoped advisory lock on connection + entity type + remote id) and
re-reads the mapping inside that lock; a delivery that loses applies its payload
as an update (`createForRemoteOnce`). A new mapping is inserted with
`DO NOTHING` and a conflict rolls the item back (`insertNewMappingOnClient`), so
no path can orphan a row by re-pointing a mapping. The variation stub takes the
same lock under a savepoint.

Not every shared SKU is a bug. WooCommerce reports a variation with no SKU of
its own under its parent's SKU, so a variable family legitimately shares one.
Other causes the code still allows, by design or because a constraint would
need a migration: two different store products with one SKU (fix it in the
store); a store re-linked as a new connection (mappings are per connection, so
deleting a connection and adding it again re-creates every product); Holoo
goods and WooCommerce products with one SKU (two sources, two mappings); and
items are per branch. A partial unique index such as
`(location_id, lower(btrim(sku))) WHERE kind <> 'variant_child'` was considered
and **not** added — existing tenants already hold duplicates and a variation
can legitimately repeat its parent's SKU, so it needs a cleanup decision first.

### The report: `scripts/report-duplicate-items.ts`

Read-only, one business at a time, inside `withTenant` on a `READ ONLY`
transaction that is rolled back. It never merges, archives or deletes.

```bash
npx tsx scripts/report-duplicate-items.ts --business <uuid>                 # every duplicate SKU
npx tsx scripts/report-duplicate-items.ts --business <uuid> --sku zza05023  # one SKU, case-insensitive
npx tsx scripts/report-duplicate-items.ts --business <uuid> --json          # machine-readable
```

For each SKU carried by more than one item it prints each row's id, name, kind
and parent, active flag, branch and on-hand quantity, created time (Shamsi; ISO
in `--json`), every integration mapping (connection, provider, remote id,
remote parent id), the newest `product.*` payload the store sent for that
remote id, and a verdict (`src/lib/duplicate-items.ts`):

| Verdict | Meaning | What to do |
|---|---|---|
| `variant_family` | a parent and its own variations | nothing — legitimate |
| `per_branch_copies` | one row per branch | nothing — items are per branch |
| `race_orphan` | a mapped row and an unmapped twin created within ten minutes of it | the unmapped row is the orphan; move any stock/history it took, then archive it |
| `same_remote_mapped_twice` | one store record mapped by two connections to the same store | keep one connection; archive the other's rows |
| `distinct_remote_records` | different store records share the SKU | correct the SKU in the store |
| `unmapped_duplicate` | at least one row no integration owns | decide by hand which row is real |

Before archiving an orphan, check that it has no orders, stock movements or
batches of its own; the report deliberately does not decide that for you.

## Tests

| File | What it proves |
|---|---|
| `integration/woocommerce-duplicate-items.integration.test.ts` | F13 — concurrent deliveries of one new product (simple, variable parent, variation) make one item; an order with one unmapped variation on two lines makes one stub; the report's verdicts, provenance, snapshot, SKU filter and business isolation |
| `src/lib/duplicate-items.test.ts` | the verdict rules and helpers |
| `src/lib/integrations/woo-catalogue.test.ts` | 39 — the type matrix, order-line resolution, update paths, taxonomy tree sort |
| `src/lib/integrations/woocommerce-client.test.ts` | 23 — both namespaces, pagination, update paths |
| `src/lib/integrations/woo-ops-service.test.ts` | 16 — the closed field lists, price/quantity/refund validation, `api_refund` forced false |
| `integration/woocommerce-catalogue.integration.test.ts` | 14 — end to end against Postgres: variations as sellable children, a line resolving to the variation, webhook vs plugin landing on one row, taxonomy replace-not-merge, the ops queue carrying `__parentRemoteId` |

The integration test seeds the **retail** chart of accounts (`1340` inventory,
`4560` sales revenue, `5140` COGS) because its business is `accessories`; the
F&B codes the older WooCommerce test seeds would make order ingest throw.
