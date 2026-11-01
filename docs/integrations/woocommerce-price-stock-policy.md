# WooCommerce price & stock: the authoritative policy (issue #943)

One product, two ledgers: the **Accounting catalogue** (local `items` +
`item_stock`, or `menu_items` for F&B) and the **WooCommerce store** (its own
prices, stock and publication). This document is the explicit contract for
which ledger wins, when a value crosses between them, and what the UI must
show. Code references are the enforcement points; the tests named at the
bottom are the proof.

## 1. Authority

1. **The Accounting catalogue is the local source of truth.** Prices and
   quantities are edited in the Accounting app (validated services, integer
   Rial, weighted-average cost, the whole posting machinery). The Products
   page under «websites → WP» never edits local values.
2. **The store is the truth about the store.** What WooCommerce shows —
   publish status, `manage_stock`, its own regular/sale price, its primary
   image, its short and long description — is mirrored inward at every sync
   (`recordProductShape`) and displayed as *last-seen* values. The mirror is
   never sent back on its own: inbound reads cannot become outbound writes.
   Imagery in particular is read-only in both directions until #941's
   attachment transport lands.
3. **Store-side overrides are explicit, human, and queued.** The Products
   page is the only place a store-side value is written from this app: its row
   editor, and — for the storefront text alone — the per-product «محتوا و
   تصاویر» sheet (issue #1215), which reads the store's own short/long
   description out of the same mirror and writes either field back **only**
   when the owner presses «اعمال», through the ordinary product outbox. A
   description travels verbatim (Gutenberg HTML intact) and is refused, not
   truncated, past the limits in `src/lib/product-content.ts`; the AI draft
   that may fill the field never writes anything. It goes through `sanitizeProductPatch`'s closed allowlist
   (`name`, `regular_price`, `sale_price`, `stock_quantity`,
   `manage_stock`, `status`, `description`, `short_description`) — never
   `type`, `parent_id`, `sku`, `attributes`, `categories` or `images`, which
   restructure a catalogue the store owns. Structural changes remain a
   separate reviewed workflow, per the audit.

## 2. The scheduled diff (local → store)

`refreshOutboxForConnection` (outbox tick, «sync inventory» route,
autopilot) pushes Accounting values to the store under these rules:

- **Switches, both levels.** The connection's `push_prices` / `push_stock`
  are the per-store switches; the mapping's `pricePushPaused` /
  `stockPushPaused` metadata are the per-product ones (set from the row on
  the Products page via `setProductPushPause`). Pausing also drops that
  axis's not-yet-sent scheduled events — a pause that leaves a queued push
  in the queue is not a pause. Manual edits still queue while an axis is
  paused: the switch stops the automation, not the owner.
- **The diff is against the acknowledged state.** `lastPushedPayload`
  (`stock`, `priceRial`) records what the store last *acknowledged*, written
  by the drain/plugin ack — not what was last enqueued.
- **No overwrite, no loop.** The guarded upsert (`upsertOutbox`):
  - never touches a `processing` event (leased by the drain or the plugin —
    rewriting it would deliver a value the queue no longer shows);
  - never resurrects `dead` / `needs_review` events (a human parked them;
    only the row's explicit «retry» button may re-arm them — §5);
  - never resets `attempts` / `next_attempt_at` on a `failed` event (the
    backoff survives the tick; the fresh payload rides the next retry);
  - re-arms a `sent` event **only** when the acknowledged diff says the
    local value actually moved (comparing against the sent event's payload
    instead would re-push a delivered manual override the moment the local
    value differed from it);
  - writes nothing at all in a steady state — an unchanged payload is a
    no-op, so the tick cannot churn or hammer.
- **Manual edits own their axis while open.** `openManualProductAxes` keeps
  the scheduled price push off a product with an open manual
  `regular_price`/`sale_price` edit (same for stock), so the automation
  never races a human decision to the store. When the manual event is
  acknowledged, the drain records the local price/stock of that moment; the
  override stands **until the Accounting value next changes** — at which
  point the local master re-asserts itself and the push resumes. That is
  deliberate: the override is a store-side decision, not a second ledger.

## 3. Stock semantics — never a fabricated tracked quantity

- Only **stock-tracked shapes** may receive `stock_quantity`/`manage_stock`:
  `simple`, `variation`, `bundle`, `composite`, `subscription`, and unknown
  types (the `unknown → simple` default). `variable` and `grouped`
  containers hold no quantity of their own; `external`/`affiliate` products
  are sold on someone else's site. `desiredState` refuses the stock axis for
  untracked shapes even when a stale `item_stock` row exists, and the
  catalogue reader nulls their `quantity` (`stockTracked: false` on the
  row) — an «out of stock» count that includes untracked shapes would be a
  count of numbers this app invented.
- Manual stock entry for a product the store does not track requires the
  explicit `manage_stock` opt-in in the editor (UI blocks it;
  `sanitizeProductPatch` validates the boolean strictly — the string
  `"false"` may never coerce into turning tracking *on*).
- `stock_quantity` must be a non-negative safe integer; blank/NaN/decimals
  are refused, never floored or zeroed.

## 4. What the row shows (all five values)

| Column on the row            | Source                                              |
| ---------------------------- | --------------------------------------------------- |
| **local** price              | Accounting (`item_stock.unit_price` / menu price), integer Rial rendered in the business's money unit |
| **remote** price/status/image | `recordProductShape` mirror at the last sync (`remoteRegularPriceRial`, `remoteSalePriceRial`, `remoteStatus`, `remoteImageSrc`) |
| **pending**                  | the open outbox patch, in words (`pendingPatchText`) — what the store will receive |
| **failed**                   | outbox `failed`/`dead`/`needs_review` state + the store's own error text |
| **last synced**              | the mapping's clock (`lastSyncedAt`) and the last acknowledged send (`queue.lastSentAt`) |

Plus, since item 5: the per-row queue badge (queued / failed), the explicit
«تلاش دوبارهٔ ارسال» retry, the link to «صف و رویدادها» (queue diagnostics),
the per-product auto-push switches, the «در فروشگاه دیده نشد» flag for
products a complete store read no longer saw (flagged, never deleted), and
the sync banner's honest counts — created / updated / **skipped** /
variations / containers, failures with ids, variation-fetch failures, and
**missingRemotely**.

## 5. Retry policy

Automatic retries use backoff and end in `dead` after the attempt cap;
`needs_review` parks conflicts a human must read. The **only** path that
resurrects a parked event is the explicit per-product retry
(`retryProductQueue` behind the row's retry button, `woocommerce.manage`,
audited as `product.queue_retry`). The scheduled refresh is structurally
forbidden from doing what the button does.

## 6. Publication and images — and exactly what is blocked on #941

- **No automatic publication, ever.** Nothing in sync, refresh or export
  writes a product `status`. Publication changes only through an explicit
  manual patch from the row editor (validated against the
  `publish/draft/pending/private` enum) — the «explicit publish review» the
  audit requires. A saved Accounting product reaching a store as `draft`
  stays `draft` until a human says otherwise.
- **Variation association** is one central rule: `parentRemoteIdFromMeta`
  resolves the parent recorded on the mapping at sync, and every outbound
  path (manual enqueue, scheduled refresh, REST drain, plugin payload)
  routes variations to `products/{parent}/variations/{id}` (`wooUpdatePath`)
  instead of 404ing against `products/{variation}`. Locally,
  `planWooCatalogueWrite` makes parent-before-child a property of the whole
  page, so a child listed first is deferred, not lost.
- **Images are a display-only mirror today.** The primary image (lowest
  `position`) and its alt text are recorded at sync and shown on the row.
  The app never sends images outbound (`images` is absent from the patch
  allowlist), so no push can clobber a store's imagery.
- **Blocked on #941 (not landed):** uploading or attaching product images —
  cover/gallery/variant media — requires the canonical store-specific
  attachment mapping, transport, dedup and ACK lifecycle that issue #941
  owns. As of this writing **issue #941 is open and its implementation PR
  #1045 is open**; no canonical media-mapping table or attachment outbox
  exists on `main`. Building a product-image uploader here would create
  exactly the second, independent media transport the audit forbids
  («do not create a second independent library. Coordinate with #941»).
  When #941 lands, the hook points are ready: the shape record already
  carries the remote image identity, the variation routing rule already
  delivers to `products/{parent}/variations/{id}`, and the outbox already
  provides the retry/ACK/partial-failure machinery an attachment queue
  needs. #926 (canonical Media) and #951 (explicit publish initiation)
  remain the owners of the asset store and the publish flow respectively.

## 7a. Who owns the number, and what a stock push may do (issue #1149)

- **`source_of_truth`** (`store` | `pos` | `two_way`, migration 0258) decides
  the authority per connection. `store` switches the scheduled stock/price push
  off whatever `push_stock` / `push_prices` say; `pos` and `two_way` leave the
  two switches in charge. Existing connections default to `two_way`, so nothing
  changes until an owner chooses. One pure function,
  `effectivePushSwitches` (`outbox-policy.ts`), is read by the refresh, the
  tick and the handshake (the plugin is told the effective values).
- **Turning a push off closes its queue.** In the same SQL statement as the
  switch, still-waiting (`pending`/`deferred`/`failed`) stock or price jobs
  become `skipped` / `push_switch_off`. Leased jobs finish; `dead` and
  `needs_review` are a human's; manual `product_update` events are never
  touched. Switching back on re-arms them on the next tick.
- **A stock push never switches tracking on by itself.** The quantity is sent
  only for a product the store already tracks (`remoteManageStock === true`),
  or — with the connection's `manage_stock_opt_in` — together with
  `manage_stock: true`. An untracked or never-synced product gets no stock job,
  so the catalogue is no longer sent `manage_stock = true, quantity = 0`.
- **A job is dropped before it is leased** (`dropRedundantPushJobs`) when its
  value equals what the store last reported (`equal_to_remote`, recorded as
  acknowledged so the diff stays quiet) or when it is older than 24 hours
  (`stale_job`; the next tick re-arms the row with the current value).

## 7. Where each clause is proven

- SQL-scoped catalogue page, >1000 rows, interleaved updates, tenant and
  connection scoping, untracked-quantity honesty, missing-remotely flag:
  `integration/woocommerce-catalogue-page.integration.test.ts`.
- Refresh guards (steady-state no-op, leased/dead/needs_review untouched,
  backoff kept, sent re-arm only on acked change, manual-axis priority),
  shape guards, per-product pause, human retry, flag-and-clear:
  `integration/woocommerce-outbox-refresh.integration.test.ts`.
- Patch allowlist + strict validation: `woo-ops-service.test.ts`,
  `store/products/route.test.ts`. Variation routing + parent-before-child:
  `woo-catalogue.test.ts`, `outbox-service.test.ts`,
  `integration/woocommerce-catalogue.integration.test.ts`.
- Permission gates (`woocommerce.view` for the catalogue,
  `woocommerce.manage` for pushes/pause/retry) and the cross-tenant 404s:
  the route unit suites plus the route-level matrix in
  `integration/woocommerce-catalogue-page.integration.test.ts`.
