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
| Unmapped **simple** row beside a mapped **variable** product of the same name (the August flat copy) | `historical_variant_orphan` | same branch + SKU + normalised name, one mapped `variant_parent` with at least one mapped child; two candidate families stay `unmapped_duplicate` |
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
`ambiguous_twin`, `twin_not_woo_product`, `twin_inactive` and
`twin_not_variant_family` are the blockers; each is shown to the operator in
Persian on the products screen.

Archive means `items.is_active = false`. The row, its stock snapshot, its
mappings and its history stay. It is reversible and audited
(`item.duplicate_orphan_archived` / `item.duplicate_historical_archived` /
`item.duplicate_variant_orphan_archived`).

## Explicit resolution states

The review screen and `GET /api/products/duplicates` distinguish:

| State | Meaning | Counts as resolved? |
|---|---|---|
| `pending_review` | proven duplicate, safe archive available | no |
| `safely_archived` | archived by this workflow; restore available | yes (deduplicated) |
| `blocked_stock` | orphan still holds quantity | no — stock-authority decision |
| `blocked_history` | orders/invoices/price history point at it | no — keep it or retain history |
| `kept_separate` | audited decision that the rows are different | yes, **not** a deduplication |
| `history_retained` | audited decision to keep a reference-carrying row | yes, **not** a deduplication |
| `restored` | archived here, then restored; decision required again | no |
| `archived_elsewhere` | inactive for a reason this workflow cannot undo | yes, not by this workflow |

`keep_separate` and `history_retained` never change `items`; the API summary
stops returning the SKU, but the product is not deduplicated. A row that holds
stock is refused by `history_retained` (`duplicate_history_has_stock`) because
history and stock are separate decisions.

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

Archiving is `is_active = false`. The review screen offers «بازگردانی نسخهٔ بایگانی‌شده» for the plan's own
archived row (`restore_archived`), which flips it back and writes
`item.duplicate_archive_restored`; it refuses a row that is not inactive, has a mapping, or was not archived
by this workflow. At the data level the audit row names the id, the twin, the quantity and the timestamp.
Do not delete the audit row and do not re-point a mapping as part of a recovery.

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

## Stock-authority preview (read-only, #1592 batch 3)

The 304 pairs whose older row still holds quantity need an owner decision about
which snapshot is the physical stock. The preview is evidence only — **no apply
path exists in this release**:

```bash
npx tsx scripts/preview-duplicate-stock-authority.ts --business <uuid>
npx tsx scripts/preview-duplicate-stock-authority.ts --business <uuid> --sku <sku> --json
GET /api/products/duplicates/stock-authority?sku=<sku>
```

For each stocked pair it prints the orphan quantity, the surviving row's
quantity, the newest `stock_quantity` the store sent (with its timestamp) and a
verdict:

- `safe_to_archive` — the surviving row equals the store; the orphan is a stale
  snapshot of the same units. `physicalUnitsDelta` is 0; only the duplicated
  catalogue count would disappear.
- `needs_store_reconciliation` — the store is missing/negative, neither row
  matches, or the store agrees with the orphan rather than the canonical row.
- `needs_history_disposition` — the stock is safe but orders/invoices/price
  history still point at the orphan; keep the history or approve the archive
  explicitly. It is excluded from the approval token.
- `manual_review` — a variable product (stock is per variation).

`approvalToken` hashes the safe rows' exact evidence (item ids, quantities,
store quantity/time); a changed store quantity changes the token. An owner
approval must name that token. Implementing an approved apply remains a
separate, reviewed change; it must reuse the guarded archive (audit, row lock,
restore) and must never write `item_stock`, aggregate two snapshots or rewrite a
posted document.

## Connection mapping provenance (#1592)

A normal disconnect is a soft delete (`deleted_at`) and keeps mappings. If a
connection row is physically deleted, migration 0323's `BEFORE DELETE` trigger
copies the connection snapshot and every mapping into
`integration_mapping_provenance` before the FK cascade. Read it with
`listMappingProvenance()`; it is evidence for a deliberate re-link, never an
automatic mapping restore.

## Reporting

Archived duplicates are `is_active = false`, so operational stock views
(`/api/stock/stock-levels`, `/api/stock/warehouses`, products list) exclude them;
warehouses report their value separately as `inactive_stock_value_rial`. The
duplicate review keeps listing the row (labelled `safely_archived` with restore)
for audit and recovery. `GET /api/products/duplicates?summary=1` no longer
returns a SKU whose duplicate is archived, kept separate or history-retained.
Sales, refunds and journal rows are never rewritten by any of these states.
