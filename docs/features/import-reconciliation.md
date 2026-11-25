# Universal safe import & first-sync reconciliation (issue #1118)

When a business already has records in Bizamiz and/or several external systems,
connecting a provider, installing a plugin, importing a file or re-importing a
dataset must **match, link and review before anything is written**. This is one
shared capability — not a Holoo merge, not a WooCommerce special case — built on
the Data Transfer engine ([data-transfer-engine.md](data-transfer-engine.md)) and
`integration_mappings`.

> The shared engine powers the [reviewed XLSX product catalogue](xlsx-product-catalogue.md)
> for Watch and retail, the provider first handshake, WooCommerce product sync,
> Holoo base/workbook feeds and populated Data Transfer imports. The paths that
> run through it, and the domains still owned by a follow-up issue, are listed
> under [What runs through it](#what-runs-through-it).

## The contract

1. **Safe first run.** A populated domain or a new overlapping source is staged
   and reviewed before canonical writes. An empty domain, or records that all ride
   a verified mapping, may take a visible fast path (`evaluateFirstRunGate`).
2. **No silent merges.** A name, phone, e-mail, amount, date or non-unique SKU
   alone is evidence, never a link. Auto-link needs a verified source identity, or
   exactly one candidate on a unique key whose tenant branch, type, unit,
   tracking, variant options and role all agree.
3. **Source identities are preserved.** Many sources may link to one canonical
   row; a verified identity is never silently re-pointed (service refusal *and* a
   database trigger); retiring one is a tombstone, never a delete.
4. **Field authority is explicit.** Financial and stock fields belong to the books
   and are never overwritten by arrival time; presentation and per-store price
   stay with the source. A policy that hands a source financial/stock authority is
   ignored.
5. **No automatic historical financial effects.** A past order/invoice/payment is
   matched on a source id or a trusted reference with the same total, currency and
   lines (`historical_match`); amount and date alone only raise a review item.
   Nothing is posted by the engine.
6. **Non-destructive.** Staging writes only the four tables below. Absence in a
   partial feed is not deletion.
7. **Truthful progress.** "Reconciled" needs every item terminal, none failed or
   waiting, no source event parked in the durable inbox, the run `applied`, and
   the post-apply cross-check. The run summary, wizard and report expose that
   buffered count separately from staged items.

## Where it lives

| Piece | File |
|---|---|
| Vocabulary (domains, nine outcomes, decisions, run states) | `src/lib/import-reconciliation/types.ts` |
| Identity normalisation, exact Rial/Toman and decimal arithmetic | `normalize.ts` |
| Pure resolvers: product, party, financial document, inventory | `resolvers.ts` |
| Field-authority policy and field diff | `field-authority.ts` |
| Run state machine, first-run gate, stale check, progress, outbound gate | `lifecycle.ts` |
| Batch planner (`planProducts`, …), record fingerprints | `plan.ts` |
| Tenant-scoped service (open → stage → decide → apply → cross-check) | `service.ts` |
| Tables | `migrations/0255_import_reconciliation.sql` |

`types.ts` and `lifecycle.ts` are client-safe; `plan.ts` hashes with `node:crypto`
and `service.ts` reaches the database, so a client component imports only the
first two.

## The outcomes

Every incoming record gets exactly one: `already_linked`, `safe_match`,
`create_new`, `field_conflict`, `ambiguous`, `invalid`, `historical_match`,
`skipped`, `failed`. The owner can **link**, **create separately**, **skip**,
**choose field authority** or **keep for review**; which of those is offered
depends on the outcome (`allowedDecisions`). Overruling the engine
(`create_separate` on an ambiguous record, or giving a source a protected field)
requires a reason on the record. "Approve all safe" touches only `safe_match` and
`create_new`.

## Lifecycle

```
openRun ─► stageProducts … ─► completeProductDiscovery ─► decideItem / approveSafeBatch
                                   │ (gate)                          │
                                   └─ fast path approves safe        ▼
                                                     revalidateRun ─► applyRun ─► crossCheckRun
```

* **One active run per business / domain / source / branch** (partial unique
  index). A second manual sync, webhook backfill or re-upload on the same scope is
  refused with the id of the run that owns it.
* **Staging is idempotent.** Unique on (run, type, key) plus a record fingerprint:
  re-sending a batch is a no-op, a changed record re-resolves and returns to
  review, an applied item is left alone. Duplicate keys that land in different
  bounded batches are found by an `identity_keys` sweep.
* **A stale preview cannot be applied.** `applyRun` re-validates the source
  fingerprint, policy version and canonical-state digest first; a changed one
  marks the run `stale` and sends every approval back to `proposed`. For
  connection-backed runs a relevant source event that arrived after staging also
  marks the run stale (`hasNewSourceEventsForRun`): approving product/customer/
  order data while a newer inbox event is unread would approve an old view. If
  the source or the books cannot be read (offline) the preview is `unverified`
  and is refused unless the caller explicitly accepts that.
* **Apply is resumable.** Bounded batches, `FOR UPDATE SKIP LOCKED`, one savepoint
  per item: a failing item is recorded `failed` with its error and the rest carry
  on; the run ends `applied` only if nothing is pending or failed, otherwise
  `partially_applied`. An owner can return the failed rows to review
  (`retry_failed`) and apply again; already-applied links and the decision/audit
  history are kept.
* **Domain writes belong to the domain.** The service decides *whether*; an
  `ApplyHandler` (`createProductApplyHandler`) does the write. Its `link` writes
  the source identity (and the `integration_mappings` row for a connection-backed
  source, which the existing sync code reads); `create` is delegated to the owning
  service and fails loudly (`create_not_supported`) if none is supplied.

## What runs through it

| Entry point | Behaviour |
|---|---|
| WooCommerce plugin first handshake | `ensureFirstContactReconciliationGate` opens a **discovering** product and/or party run when the tenant already has canonical rows. Bootstrap exports are still queued, but their product/customer webhooks are parked in `integration_webhook_events` as `deferred` until the run resolves. The export completion marker stages the buffered records in bounded keyset batches (`stageDeferredInboxForRun`) and completes discovery, so the run reaches review instead of sitting empty. |
| WooCommerce `syncProducts` / «تطبیق پیش از همگام‌سازی» | A populated catalogue is staged through `stageWooCatalogueToReconciliation`; the blind sync path refuses with `reconciliation_required` until review. |
| Orders and refunds during any active run | Financial webhooks wait behind the product/party run too, so a historical sale cannot create a customer or relieve stock while identity decisions are open. They stay durable in the inbox and are replayed after the last run applies. |
| Holoo base/workbook feeds | `stageHolooBaseToReconciliation` splits goods, persons, opening inventory and journals into their own runs; the create writers post through the domain services. |
| Data Transfer file imports | A populated entity is staged through `stageImportJobToReconciliation`; a completed job is finalised from the reconciled decisions, never by replaying the raw rows. |
| Review, apply, report | The shared wizard and `/api/data/reconciliation` routes list runs, decide items, set cutover policy, apply bounded batches and download a non-sensitive JSON/CSV report. The summary, wizard and JSON report show how many source events are still buffered; a run with buffered events is not "fully reconciled". |
| Outbound publication | WooCommerce price/stock pushes are gated on the item being applied, the mapping committed, ownership confirmed and no active product run; rejected remote edits are suppressed so an unchanged remote value is not echoed back. The Holoo accounting push queue waits for **any** active run on its connection, so a sale, receipt or purchase is never written while inventory/ledger ownership is still under review. |

WooCommerce product shapes are preserved through staging: a `variable` product
is a non-sellable `variant_parent`, a variation is a `variant_child` with its
parent external id and option axis, and apply writes parents before children.
A child whose parent cannot be resolved fails visibly instead of becoming a
second simple product.

Apply uses one handler per domain: product `createItem`/`createVariantChild`/
`inventory_items`, party `createParty`, Holoo journals through the posting
service, and inventory through opening/adjustment movements and lots. A run is only `reconciled` when
every item is terminal and the post-apply cross-check passes.

## Remaining owner scopes

- **#951** owns the WooCommerce-specific order/product sync architecture. Orders
  buffered by this epic are replayed through the normal idempotent order path
  after product/customer mappings commit; they are not independently reviewed as
  financial documents here.
- **#1289** owns historical sales-invoice workbooks and their posting/cutover.
- **#1376** (delivered) owns safe re-import of existing product prices and stock: the catalogue file's explicit `catalogue_only` / `fill_missing` / `update_existing` modes, current→proposed review, and the price/stock write path through `saveStockPrices` and `createItemStockCount`.
- **#1335** (delivered) owns the catalogue entry point and generic brand handling.
- Category/attribute/media reconciliation stays with the taxonomy and media
  services; the engine currently reviews product, party, financial-document and
  inventory domains.
- A live WooCommerce/Holoo store acceptance run is separate from the automated
  suite and has not been recorded for this change.
