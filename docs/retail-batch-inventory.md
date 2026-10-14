# Retail batch inventory — the canonical path (issue #770)

Cosmetics is a *capability* of the global Retail foundation, not a second
application. This note records the one inventory contract every retail channel
now goes through, so the next feature plugs into it instead of adding another
copy of "sell a stock item".

```
allocate → exclude expired → FEFO → exact batch COGS
        → decrement item_batches → roll up item_stock
        → persist the exact allocation on the order line
```

## Source of truth

For a `tracking='batch'` item (migration 0078):

- `item_batches` is authoritative. A batch carries the real lot number, expiry,
  manufacture date, quantity and unit cost.
- `item_stock` is a **rollup/cache** for the shared retail surfaces
  (`quantity` = SUM of batches, `unit_cost` = weighted average across them).
  It is written only by `recomputeItemStockRollup`.

No channel may decrement `item_stock.quantity` as if it were the source of
truth for a batch item.

## The engine

`src/lib/retail-batch-inventory.ts` is the single implementation:

| Function | Responsibility |
| --- | --- |
| `allocateBatchLots` / `allocateBatchStock` | FEFO across sellable lots; expired stock is refused, never silently sold |
| `consumeBatchAllocations` | Relieve exactly the allocated rows (guarded `UPDATE … WHERE quantity >= n`) and recompute the rollup |
| `recordOrderItemBatchAllocations` | Persist per-line allocation: `batchId, batchNumber, expiryDate, quantity, unitCost, costValue` |
| `restoreOrderItemBatchStock` | Put a returned quantity back into the **original** lot (`restockable`) or record a non-restock disposition (`damaged`/`expired`/`quarantine`/`tester`/`no_restock`) |
| `recomputeItemStockRollup`, `averageCostAcrossBatches` | The 0078 invariant, one implementation |
| `moveBatchStockBetweenItems`, `relieveBatchesForTransfer`, `receiveBatchesForTransfer`, `restoreBatchesForTransferCancel` | Branch transfers that preserve lot identity, number, expiry and cost |

`planBatchRestoration` and the allocation planner are pure and unit-tested
(`src/lib/retail-batch-inventory.test.ts`); the DB half is covered by
`integration/retail-batch-inventory.integration.test.ts` per repo convention.

## Who calls it

| Channel | Path |
| --- | --- |
| Retail POS invoice (`cosmetics` lines) | `cosmetics-service.sellCosmeticUnits` → engine; the invoice persists the allocation against the `order_items` row it writes |
| WooCommerce order | `ingestRetailOrder` → `retail-online-sale-service.sellOnlineRetailLine` → engine |
| Eshobe CMS paid order | CMS adapter → `sellOnlineRetailLine` → engine (imported as a `retail` order when the product maps to an `items` row) |
| WooCommerce refund | `ingestRetailRefund` → `restoreOrderItemBatchStock` (variation-aware mapping), COGS reversed by the value actually restored |
| CMS reversal | `reverseRetailImportedOrder` — retail reversal path, **not** F&B's `amendClosedOrder` |
| POS invoice void | `retail-invoice-void-service.voidRetailInvoice` → `restoreOrderItemBatchStock` |
| Purchase receipt | `receiveItemPurchase` → `receiveBatch` (real manufacturer/supplier lot; an internal `P-…` reference only when none is given, flagged `internal_batch_number`) |
| Supplier return | `createItemSupplierReturn` → batch relief + `recomputeItemStockRollup` in the same transaction |
| Branch transfer | `shipItemTransfer` / `receiveItemTransfer` / `cancelItemTransfer` → engine transfer helpers |
| Warehouse documents | `retail-warehouse-document-service` → `receiveBatch` / `rollItemStockToBatches` |
| Tester / expiry write-off | `openTester` / `writeOffExpiredBatches` → engine |

Each adapter only maps the external payload, resolves tenant/location/item and
records its own idempotency; the domain rules live in the engine.

## Persisted allocation

`order_item_batch_allocations` (migration 0198) holds one row per
(order item, batch): the exact lot, quantity, unit cost and cost value the sale
consumed, plus how much has since been restored or disposed of. It is what makes

- exact returns/refunds/reversals possible (never a bare `item_stock += n`),
- exact COGS reconstruction and reversal,
- recall lookup ("which customers bought lot X?"),
- replayed webhook deliveries idempotent (`order_item_batch_restorations` is
  unique on `(allocation, source_type, source_id)`).

Historical invoices have no allocations and are treated as legacy: the
reversal paths refuse them with an explicit message rather than fabricating an
allocation or silently desynchronising the rollup.

## Legacy / known limits

- A reversal of a batch line sold *before* 0198 is refused by design.
- There is no retail transfer *UI* yet; the transfer API accepts `batchId` per
  line (a named lot) and defaults to FEFO.
- Offline/desktop sale replay and import/export batch mapping are not yet
  routed through the engine; see the issue's remaining acceptance items.
