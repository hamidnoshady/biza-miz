# Accounting and WooCommerce synchronization

Accounting uses the existing product master, stock ledger, integration mappings,
outbox, REST client and signed WordPress plugin. There is no second catalogue or
inventory engine.

## Products and attributes

From Accounting Products, choose **Publish / Link store**, select stores, inspect
the preview, then confirm. Saving New Product remains local; the optional publish
panel appears after a successful save. Selection defaults to empty. A changed
selection invalidates the preview, and the server rejects a stale review token.

The parent is delivered before variations. Remote identity is recorded only from
a successful, fenced ACK or a matching authenticated product echo carrying the
reviewed operation marker. A matching SKU belonging to a different operation is
a conflict, never permission to overwrite it. A retry recovers the same remote
product. Existing mappings are retained; failed operations remain visible in the
Website Management queue. A global connection uses its effective primary branch;
it cannot publish another branch's products.

Link-only currently supports a reviewed simple product with matching SKU and
type. Existing variable-family linkage requires separate per-variation review and
is rejected rather than guessed. Publishing new variable families is supported.

On Accounting Attributes, select a store and a definition, review each local
option's remote name/slug, and approve reuse/creation. Local UUIDs never become
Woo taxonomy IDs. Only acknowledged remote attribute/term IDs form the mapping.
Changing local definitions does not silently rename or delete remote taxonomies;
review the mapping and republish affected families deliberately.

## Prices and stock

On Accounting Prices, each connection can use the base sale price or one named
price list. All stored prices remain integer Rial; conversion uses the existing
Woo currency contract. Purchase cost is never an outbound sale price. A missing
named entry is skipped, with no base-price fallback. Changing source invalidates
waiting prices from the previous source. In-flight leases remain immutable.
An inbound zero price clears the local shelf price and records the remote zero
in price history; the existing retail contract requires positive shelf prices.

The worker reads committed canonical quantities and prices, so individual/bulk
edits and posted inventory operations use the same path. Draft documents do not
move stock. Existing product switches, pauses, stock-tracking opt-in and variation
parent routing still apply. `source_of_truth=store` disables automatic outbound
stock and price changes. With outbound ownership enabled, incoming product
observations cannot replace local stock or sale prices.

Woo manages its own order stock. The app imports sales once, reconciles them
before preparing absolute outbound quantities, and never issues a second remote
decrement. Refunds share an order lock and one return header across all lines;
returned quantity and cost are bounded. Cancellation reverses remaining stock and
COGS without inventing a gateway payment refund. Repeated cancellation/refund
delivery cannot restore stock twice.

Plugin 1.6.21 records and sends the refund's explicit restock decision. A refund
without restock leaves stock and COGS untouched. Historical/external refund lines
without evidence fail visibly with `refund_restock_unknown`; they require operator
reconciliation. A confirmed return after an imported stock snapshot can restore
units whose original sale was already reflected in that snapshot. A refund
already included in the snapshot does not restore those units again.

Cancelled-order reopening remains a reconciliation case: a provably newer paid
update reports `cancelled_order_reopened_requires_reconciliation`, holding back
outbound stock. The existing immutable order import does not implement repeated
paid/cancelled cycles as new sale facts.
Do not infer acceptance of those cycles from duplicate-delivery tests.

## Configured timing and operational acceptance

* App worker: every **30 seconds**, first run after **10 seconds**, single-flight.
* REST backlog: up to **four batches of 25** per connection/pass; the **15-second**
  budget is checked between batches, not a hard timeout for an HTTP request.
* Plugin 1.6.21 fast lane: **60 seconds**. Existing fast-lane schedules are upgraded.
  Older installed plugins keep their five-minute cadence until actually upgraded.
* Silence alert: after two missed expected pulls: **two minutes** for an upgraded
  plugin reporting the minute cadence, **ten minutes** for legacy plugins.
* The hourly catalogue sweep is a reconciliation backstop, not the stock/price path.

These are configured intervals, not measured production latency. A healthy,
lightly loaded REST connection can reasonably be expected to acknowledge ordinary
edits in roughly **30–120 seconds**; upgraded plugin mode roughly **1–3 minutes**;
legacy five-minute plugins roughly **1–6 minutes**. Parent/child publication may
take another plugin pull. These ranges exclude backlog, retries, outages and
Hybrid's site-to-central hop. Traffic-driven WP-Cron has no guaranteed upper bound;
system cron must actually invoke due events at least once per minute to realize
the new plugin cadence.

Validate a real store separately: record local commit time, outbox creation/lease,
remote application, fenced ACK and mapping update; test both modes, variations,
duplicate delivery, disabled tracking, refunds with/without restock, broken cron,
and partial failures. Queue acceptance is not remote success. Build/CI success is
not deployment or measured store acceptance.
