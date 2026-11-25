# Historical duplicate products — operator runbook (issue #1592)

Read-only workflow for the زنی زیبا pairs (and any future tenant) where an older
unmapped product row coexists with a newer WooCommerce-mapped row of the same
product. Nothing in this runbook authorises a production merge, archive or
stock/ledger correction on its own.

## What is proved, and what is not

| Shape | Verdict | Evidence |
|---|---|---|
| One remote record behind two local rows (two connections / a relink) | `same_remote_mapped_twice` | the same store + remote id in two `integration_mappings` rows |
| Unmapped twin created within 10 minutes of a mapped row | `race_orphan` | same kind, branch, parent; timestamps ≤ `RACE_WINDOW_MS` |
| Unmapped twin of the same product created **weeks or months** later | `historical_duplicate_candidate` | same kind, branch, parent **and normalised name**, timestamps > `RACE_WINDOW_MS` |
| Two distinct remote records sharing a SKU | `distinct_remote_records` | fix the SKU at the source; never merge |
| Parent + its own variations | `variant_family` | legitimate; no action |
| One copy per branch | `per_branch_copies` | legitimate; items are per location |

A shared SKU is never a merge key. The historical fingerprint compares the
product name as well, and the archive re-check re-reads both the name and the
inventory under a row lock.

## Guards that block an archive

`archive` is only ever returned when **all** of these hold:

- the row is unmapped, active and has exactly one mapped WooCommerce twin;
- the twin is active and is a `woocommerce` `product` mapping;
- the orphan and the twin share the same normalised name;
- `item_stock.quantity` is **zero** (`item_stock` is outside the foreign-key
  scan on purpose, so quantity is read explicitly);
- no table with a foreign key into `items` references it (sales/order lines,
  invoices, batches, serials, barcodes, stock counts, price history, children…).

`nonzero_stock`, `inventory_unchecked`, `different_name`, `has_references`,
`ambiguous_twin`, `twin_not_woocommerce` and `twin_inactive` are the blockers;
each is shown to the operator in Persian on the products screen.

Archive means `items.is_active = false`. The row, its stock snapshot, its
mappings and its history stay. It is reversible and audited
(`item.duplicate_orphan_archived` / `item.duplicate_historical_archived`).

## Preview (read-only, production)

```bash
npx tsx scripts/report-duplicate-items.ts --business <business-uuid> --json > duplicates.json
npx tsx scripts/resolve-duplicate-items.ts  --business <business-uuid> --json > plan.json
npx tsx scripts/resolve-duplicate-items.ts  --business <business-uuid> --kind historical_duplicate_candidate
```

- `report` groups by normalised SKU, shows each row's id, kind, parent, branch,
  quantity, creation time (Shamsi on screen), provenance and the last store
  payload. It writes nothing (`BEGIN READ ONLY`, always rolled back).
- `resolve` adds the plan: `kind`, `status`, `blockers`, `references`, the twin
  and `daysApart`. It also writes nothing unless `--apply` is passed.

Baseline to capture **before** any approved change (read-only SQL against the
tenant, no `--apply`):

1. `items` count per branch, active and inactive; per-SKU stock and valuation
   (`item_stock.quantity`, `unit_cost`) for every id in the plan.
2. Sales/order lines, returns/refunds, batch allocations, serials and barcodes
   for every id in the plan (the plan's `references` is the same list).
3. Trial balance and COGS totals for the affected period (must not move — no
   journal row is written by this workflow).
4. `integration_mappings` counts per connection (must not move).
5. Sync/outbox state: no pending product publish for a blocked item.

## Applying (only after explicit owner approval of the exact plan)

The screen (`/accounting/products` → «بررسی محصول تکراری») or
`resolve-duplicate-items.ts --apply` archives only rows the plan marks
`archive`, re-checking every guard under a row lock inside its own transaction
and refusing a plan that changed since it was read (`duplicate_review_changed`).
`--apply` is **not authorised for production by issue #1592**; it needs a
separate approval that names the item ids and the expected effect (inventory
0, no references).

Blocked rows are not part of any archive. A stocked historical twin needs a
domain-approved reconciliation plan:

- decide which row owns the physical stock and which is surplus;
- move/relieve stock through the canonical inventory services (never a direct
  `item_stock` write, never an added snapshot, never a blind merge of two
  snapshots);
- keep historical invoice/order line ids and post a correction/reversal rather
  than rewriting posted records;
- confirm valuation/COGS/tax semantics with the domain owner;
- only then re-run the preview; the row becomes `archive` if it is empty.

WooCommerce stock/price pushes for a blocked item stay behind the existing
reconciliation/authority gates (`canPublishConnectionOutbound`,
`checkManualProductOutboundGuard`). Do not disable sync globally.

## Post-run verification

- item count unchanged; exactly the approved ids have `is_active = false`;
- `item_stock` quantities and `unit_cost` unchanged for every row, archived or not;
- no mapping row added, removed or re-pointed;
- one audit row per archived item with its twin and provenance;
- trial balance/COGS unchanged; no new journal entry;
- a second preview run reports `already_archived` for the approved ids and no
  new `archive` rows;
- re-enable/verify sync and confirm the mapped twin still receives updates.

## Recovery

Archiving is `is_active = false`. To recover one row, set it back to active by
the same permission-checked path that archived it (the audit row names the id,
the twin, the quantity and the timestamp). Do not delete the audit row and do
not re-point a mapping as part of a recovery.

## Recurrence prevention (code)

- Every WooCommerce creation path (REST pull, webhook, plugin push, manual sync,
  variation stub) calls `assertNoAmbiguousLocalIdentity` inside
  `createForRemoteOnce`, under the identity lock: a same-SKU active row in the
  branch that this connection does not own is staged through the #1118 product
  reconciliation run and the create is refused
  (`product_identity_review_required`). Webhook deliveries are parked as
  `deferred`, not failed.
- `createConnection` records `reconnectOf` in the audit (prior links to the same
  normalised store URL, including a deleted one). Mappings are never copied.
- Same connection + different remote id remains a source-side shared SKU and is
  reported as `distinct_remote_records`, not blocked.
