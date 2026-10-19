# #915 purchase integrity — implementation and remaining acceptance work

## Status / baseline

**Partial implementation; not acceptance-complete. Keep the PR in draft.** The
remaining work below is not an agreed exclusion from #915 and is not a claim
that the issue can be closed.

Rechecked `origin/main` on 2026-10-19: `a968c5608981d46d6889b70e3c3d74bb41fdb3a1`
(the working branch starts there), not the audit's `7b19069` baseline. Source
inspection and disposable PostgreSQL regression databases were used. No deployed
production database or live Persian browser/mobile session was audited.

## Implemented

### Retail receiving and retry identity

- Public purchase and supplier-return POSTs require a client-generated key.
  `retail_stock_requests` has tenant/operation/key uniqueness and binds branch
  plus canonical normalized payload to SHA-256. Object key order is irrelevant;
  line/serial array order is document data. Equivalent safe numeric Rial inputs
  and decimal quantities normalize to the same hash.
- `INSERT ... ON CONFLICT DO NOTHING` waits for the first writer. A subsequent
  statement reads its committed result under PostgreSQL READ COMMITTED. Same
  request returns the original document; changed branch/payload returns 409
  `idempotency_conflict`. A rollback releases the reservation, not a committed
  empty document. Do not run these helpers outside the caller's transaction.
- Purchase, all stock/batch/serial effects, journal/domain event, request result
  and Holoo enqueue share the transaction. A retry must **not** call the Holoo
  producer again: its upsert resets a previously exported event to pending.
- The UI retains both key **and submitted snapshot** in member/tenant/resolved
  branch-scoped local storage. Rapid taps are guarded synchronously, before a
  disabled button render. Response loss and reload/reconnect retain identity;
  retries explicitly submit the original snapshot, not changed form inputs.
  A confirmed 400 rollback resolves the rejection and allows correction. A
  malformed/truncated success response does not resolve the pending receipt.
  Unknown/transport/COMMIT errors are not reported as resolved 400 rejections;
  the key must survive an uncertain commit. Stale branch submissions are refused.
- Internal/import callers without a key remain compatible; they must retain
  their own canonical upstream document identity. This is not a new offline
  purchase queue or a second integration engine.

### Identity, provenance and accounting

- Supplier aliases on retail receipts are checked for active status, branch and
  tenant. Item and branch ownership are explicitly checked even for privileged
  import callers. A linked return locks and validates its received purchase.
- Receipts retain the actual `batch_id`, and a separate association records
  **every** acquired serial, including multi-unit lines. Manufacturer lots may
  still merge across receipts. Linked returns require the acquired batch/serial
  and enforce cumulative purchase-line quantities while holding the purchase
  lock. Repeated SKU lines require an explicit `purchaseItemId`, not an arbitrary
  first match. Historic returns without that field are conservatively counted.
- New associations are not guessed for historic multi-unit serials or batches.
  Historic single-unit serial links are backfilled. An unverifiable linked
  return is refused, rather than granting false provenance. A migration/review
  process for older records is remaining work.
- Unlinked supplier returns **remain supported**, including #795's canonical
  supplier-claim path. Their valuation remains current carrying unit cost for
  fungible/batch stock and the physical serial's own cost. No alternate supplier
  ledger was added: legacy unlinked A/P goes to #826's visible unattributed
  bucket. A named-supplier workflow for those returns is still needed; preserving
  this compatibility does not settle that product/accounting decision.
- Purchase settlement is now explicit cash / bank-clearing / credit using the
  existing chart codes and posting engine. Public credit receipts require a
  supplier. The existing A/P source attribution, return attribution and `payBill`
  paths remain authoritative. No split settlement or supplier-advance allocation
  was introduced.
- Purchase costs and totals cross the boundary as integer Rial text, accept safe
  legacy numeric inputs only, and reject unsafe Numbers or bigint overflow.
  Receipt average-cost calculations and batch rollups no longer pass through
  Number. The UI uses exact money parsing/formatting and Decimal/bigint totals,
  not rounding entered costs. Positive quantities honor numeric(24,9) storage.
  Other retail sale/report APIs still have numeric cost models; this is not a
  platform-wide money-type migration or an exact carrying-value redesign.

### Food-service returns and validation

- Detail lot lookup uses `purchase_receipt_cost_allocations.purchase_item_id`,
  not the first purchase+SKU lot. Remaining lot quantity is shown per line.
- FIFO/LIFO return transactions verify the allocation, exact purchase line,
  receipt, item and branch. Line ceilings are checked under the purchase lock;
  supplied unrelated lots cannot relieve another line's higher value. Negative
  settlement allocations never become returnable physical lots. Weighted-average
  retains its distinct receipt-value logic.
- Shared draft-line validation now rejects malformed shapes, UUIDs, impossible
  dates, quantity/conversion overflow and line/aggregate bigint overflow before
  SQL. New draft/edit supplier aliases must be active. History filters validate
  UUIDs, dates and page ranges.
- Ordered/cancelled purchases cannot be physically deleted; received records
  still require returns. Only drafts can be deleted. This preserves the later
  states as audit records, but a complete external-reference/provenance-aware
  draft deletion/tombstone policy is still outstanding.

### Ownership and UX

- Phase 45's runtime `siteSkipsPulledEvent`, deployment/site-route guards and
  cloud-only Accounting workspace are authoritative. Two stale metadata entries
  (`data-ownership.inventory_movements`, catalogue `stock_and_lots`) advertised
  site-authoritative/bidirectional inventory. They now match runtime behavior.
- Food-service draft edit/order/cancel/delete are cloud-only workflow, not
  replicated draft rows; they deliberately do **not** get invented desktop
  update/delete events. A paired site has no purchase workspace and acknowledges
  legacy pulled inventory/transfer events without replaying stock or journals.
  Retail `retail.purchase_received` / `retail.supplier_return` posting events
  remain cloud domain events, not new desktop replay types. Supported site-route
  guards and registry acknowledgement behavior are covered by regressions.
- Both purchase adapters receive effective `purchases.manage`; retail returns
  retain the API's distinct `inventory.adjust` permission. Read-only history and
  detail remain accessible. Permission hiding does not replace server checks.
- Initial retail load and food-service detail failures show retry. Filter/detail
  request generations or aborts reject late responses. Mutation retry busy state
  is released with `finally`.
- Both histories have server-side 25-row pagination, count and exact goods totals,
  date/supplier filters and document/item search (retail also SKU). This replaces
  the sole silent 100-row window. Totals/count and page reads are separate queries,
  not a repeatable-read report snapshot; concurrent inserts can change pages.
- Periodic supplier return is still unsupported by its perpetual service. The UI
  now explains that limitation rather than offering a guaranteed error. **This
  does not implement periodic credit notes or authorize a substitute stock path.**
- OCR recognized invoice number/date reach editable invoice fields, filling blank
  fields without overwriting deliberately edited values. Existing media ownership
  checks and match/review behavior remain; full tax/payable extraction is not added.

## Remaining work before #915 can be closed

1. **Retail purchase documents:** draft → ordered → received state machine,
   server audit/version/transition guards, correction/reversal policy, purchase
   date distinct from receipt time, supplier invoice number/date, VAT, terms,
   due date, attachments/OCR, print/export, and complete detail/receipt/return
   history. Propose full receipt only for v1, with no destructive posted edits;
   that partial-receipt decision has not been approved.
2. **Periodic credit notes:** account 5105, VAT and settlement posting, fiscal and
   periodic closed-period policy, multiple closing-period reconciliation and
   tests. Gating the action is only the interim safeguard.
3. **Return accounting:** approved named-supplier semantics for unlinked retail
   returns, valuation/rounding conservation for fractional retail carrying value,
   return VAT once retail invoice VAT exists, supplier advances and split/partial
   settlement only through canonical A/P. Food-service return payload-bound
   retry identity (its existing pre-hash duplicate path) also needs a separate
   regression/fix; this change hardens the retail return request identity.
4. **Historic provenance:** reviewed mapping for older merged batch receipts and
   multi-serial lines; do not silently infer physical acquisition. More negative
   settlement/weighted-average/depleted-value/concurrent food-service cases and
   real app-role cross-tenant/branch API tests, beyond the included service and
   general RLS regressions, are required.
5. **UX/reporting:** warehouse/status selectors and warehouse provenance filters,
   full data export and printable detail, retail batch-return selector and
   purchase-line selector, attachments/actors/accounting-source presentation,
   explicit pending-request recovery/reconciliation UI and cross-tab draft
   ownership. Mobile/RTL browser and a11y verification has not been performed.
6. **OCR:** extracted VAT/payable values, large/ambiguous totals and currency/date
   cross-checks, explicit grand-total approval, preserved-field review UI and
   expanded OCR integration tests.
7. **Lifecycle/sync:** external-reference-aware deletion auditing and additional
   hybrid reconnect/recovery integration coverage. Existing site-route and
   registry tests prove the cloud contract, not a full paired-device E2E run.

## Regression coverage / quality gates

- Disposable PostgreSQL: retail stock (concurrent same-key receipts/returns,
  payload/branch conflict, lost response, posting rollback/retry, exact >2^53
  amounts, cash/bank/credit, supplier checks, acquisition links, return ceilings,
  physical-stock races, canonical A/P settlement); retail batches; serialized
  watches (#795); tenant-isolation RLS; F11 purchase/VAT/payables, plus repeated
  item FIFO/LIFO lots, manipulated lot, depletion, negative settlement and
  non-draft deletion regressions.
- Unit/route/component: input bounds/shapes/date/UUID/currency, request snapshot
  retention/remount/rapid taps, retry outbox suppression, permissions, fetch
  retry, periodic gating, OCR metadata preservation and ownership contract.
- Node 24 is used via `npx -p node@24` (the sandbox default is Node 22).
  `tsc --noEmit` needs `NODE_OPTIONS=--max-old-space-size=3100` in this sandbox.
- The full unit suite, full lint and typecheck are run; the PR records final
  counts and any failures. No production build/deployment, browser E2E or
  production-data migration was performed.


### Recorded results (2026-10-19)

- Full unit/component/route suite: **945 files passed, 1 skipped; 12,479 tests
  passed, 7 skipped**. Later branch/uncertain-COMMIT route cases were additionally
  run in the focused suite after that full run.
- Purchase-related database suite: **5 files / 124 tests passed** (food-service
  payables 24, retail stock 19, retail batches 14, watches 45, tenant isolation 22).
- Final typecheck, repository lint (`--max-warnings=0`) and `git diff --check`
  passed. Focused reruns cover the final retry/error-handling refinements.
