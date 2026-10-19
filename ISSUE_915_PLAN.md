# Issue #915 — Audit: انبار / خرید — purchase integrity, retail receiving, supplier returns

Scope note: #915 is a broad audit epic. This change fixes every **source-confirmed
integrity/security defect** that was still present on current `main` (the audit baseline
`7b19069` predates `main`; each finding was re-verified against the current tree before
coding), adds regression tests for each, and records below the product decisions taken and
the audit items that were **verified as already solved** or deliberately deferred with the
reason. Per the issue's definition of done, nothing confirmed is left open without either a
fix+test or a documented reason.

## Fixed in this change (each with a regression test)

### P0 — duplicate retail purchase/stock/AP on POST retry

`POST /api/stock/purchases` created a fresh purchase UUID per request; a retry after a
committed-but-lost response double-posted stock and Debit Inventory / Credit AP.

- Migration `0232_item_purchase_idempotency.sql`: `item_purchases.idempotency_key` +
  `request_hash`, partial unique index `(business_id, idempotency_key)`;
  `item_supplier_returns.request_hash` (the key column already existed there since 0084).
- `receiveItemPurchase` accepts `idempotencyKey`/`requestHash`: identical retry returns the
  **original** receipt (`duplicate: true`, no second stock receive, journal entry, domain
  event or Holoo outbox row); same key + different canonical payload hash →
  `RetailIdempotencyConflictError` (409); a lost unique-index race →
  `RetailIdempotencyRaceError`, which the route resolves by rolling back and answering from
  the committed winner (or 409 if the payloads differ). One transaction still covers
  document + stock/batch/serial + posting + outbox; a mid-receipt failure rolls back whole
  and frees the key.
- The hash binds the key to tenant + branch + operation + canonical payload
  (`retailRequestHash`), so a key cannot be replayed across branches or operations.
- UI (`stock/purchases-section.tsx`): a stable `idempotencyKey` is generated client-side,
  kept across retries of an unchanged payload, regenerated when the payload changes or after
  success; re-entrancy guard in `submit()` (not just the disabled button) and `try/finally`
  around the busy flag.
- Tests: `integration/retail-purchase-integrity.integration.test.ts` — identical retry,
  same-key/different-payload conflict, concurrent same-key race (exactly one winner, zero
  duplicate stock/journal/events), rollback-frees-the-key.

### P1 — supplier/branch identity and return provenance (retail)

- `receiveItemPurchase` now verifies `supplierId` is an **active supplier of the
  transaction's branch** before insert (the FK alone accepted any supplier row).
- `createItemSupplierReturn` with a `purchaseId` now verifies the purchase belongs to the
  active **tenant and branch** and is `received`, takes a row lock to serialise concurrent
  returns, and enforces per-item provenance:
  - the returned item must have been acquired under that purchase;
  - cumulative returned quantity (across prior returns **and** earlier lines of the same
    request) can never exceed the purchased quantity — a second purchase of the same SKU
    does not widen the first purchase's ceiling;
  - a batch return must name a lot that purchase actually delivered (matched on the line's
    recorded `batch_number`; receipts predating migration 0198's lot columns fall back to
    item membership);
  - a serial return must name a unit that purchase delivered when its lines record exact
    units (`item_purchase_items.serial_id`; multi-unit serial lines keep provenance through
    the serial rows themselves — documented in code).
- **Unlinked returns (no `purchaseId`) remain supported deliberately**: they value at the
  item's current recorded cost basis and settle by the chosen method — goods received
  before this system or negotiated give-backs. This is now stated in the service docs.
- Return idempotency: the previously-ignored payload is now hashed; same key + different
  payload → 409. The returns UI (`stock/returns-section.tsx`) now sends a stable key across
  retries (previously the server generated a random key per request, so a response-loss
  retry duplicated the return).
- Both routes shape-check every UUID (supplier, purchase, item, batch, serial) → stable 400
  instead of a raw Postgres cast error.
- Tests: cross-tenant/cross-branch purchase ids, unknown purchase, unrelated item,
  over-return (sequential and multi-line single request), batch/serial provenance
  mismatches, inactive/foreign supplier, unlinked-return preservation, return hash conflict.

### P1 — food-service receipt lot mapping ambiguous for repeated items

- `GET /api/inventory/purchases/[id]` resolves each line's returnable lot from **that
  line's own `purchase_receipt_cost_allocations` row** (`allocation_kind='positive_stock'`),
  not "first lot of purchase+item". Legacy fallback applies only when the line has **no**
  allocation rows of any kind, so a line whose receipt fully settled negative layers
  correctly resolves to NULL instead of borrowing another line's lot.
- `createSupplierReturn` (lot-based methods) refuses a lot that is not the named line's own
  allocation (`supplier_return_lot_mismatch`, added to the terminal sync-error set and the
  Persian error map); receipts predating the allocations table keep the existing
  purchase+item association. Weighted-average keeps its existing distinct value logic
  (untouched — it never used lot ids).
- Tests: `integration/supplier-return-lot-provenance.integration.test.ts` — two lines of
  the same SKU at different prices produce distinct lots, cross-line lot refused, each line
  valued at its own price, lot remaining qty/value reconciled, legacy (no-allocations)
  receipt still returnable.

### P1 — periodic-system supplier return offered in UI but always errors

Product decision (allowed by the issue: "until supported, gate the UI"): the periodic
credit-note posting path is **not** implemented here — a periodic purchase is journal-only
(Debit 5105) and its return belongs to the accounting credit-note workflow, which needs its
own design around closed-period handling (follow-up). The «برگشت به تأمین‌کننده» button in
the food-service purchases section is now replaced, for `inventorySystem === "periodic"`,
with an explanatory state naming that workflow, instead of an action that always returns
`periodic_system_unsupported`. Server guard unchanged (still refuses, still covered by
`src/lib/periodic-system-guards.test.ts`).

### P2 — resilient fetching (retail)

- Retail purchase and returns sections: a failed initial fetch now renders a Persian error
  with a «تلاش دوباره» button instead of an endless skeleton. (The food-service section
  already had list-error + retry.)

### P2 — OCR invoice metadata does not reach the purchase

- The recognised supplier invoice number (displayed in the review panel but never
  forwarded) and the recognised invoice date are now applied into the **editable**
  supplier-invoice draft fields (`invoiceNumber`, `invoiceDate`) on «انتقال به فرم». The
  existing replace-confirmation now also counts a hand-typed invoice number as content, so
  user edits are never silently overwritten; VAT keeps its follows-the-lines proposal until
  touched; nothing posts without the operator's review (unchanged).

## Verified as already solved on current `main` (not reimplemented)

- **Food-service purchase lifecycle** (draft→ordered→received/cancelled, supplier invoice
  number/date, VAT, payment terms/due date, media attachment, settlement cash/bank/credit)
  — present and tested (`f11-payables.integration.test.ts`, purchase routes).
- **FS supplier-return VAT reversal** — cumulative, ledger-read, serialised by the purchase
  row lock (Audit F11 implementation; regression suite passed).
- **Serialized watch purchase/return (#795)** — exact-unit receipt and `supplier_returned`
  terminal state; `watch.integration.test.ts` (45 tests) passes against this change.
- **Batch/FEFO architecture (#770)**, **retail warehouse documents**, **negative-stock
  settlement** — regression suites run and pass unchanged.
- **A/P supplier attribution (#826)** — the retail return continues to post through the
  existing `retail.*` posting rules; no alternate supplier ledger was introduced.
- **FS list fetch resilience** — the FS purchases list already had error + retry.

## Deferred (reported, out of this change's scope — follow-up candidates)

Per AGENTS.md rule 6/7, these audit items are product/architecture work beyond the
confirmed-defect fixes above and are intentionally not attempted here:

1. **Retail settlement & document lifecycle** (cash/bank/credit choice at receive, draft →
   ordered → received states, supplier invoice metadata, print/export for the `items`
   model): a product decision on partial receipts/correction policy is explicitly requested
   by the issue; today's behaviour (receive-immediately, AP credit) is unchanged and
   consistent.
2. **Purchase edit/order/cancel/delete sync lifecycle reconciliation** (FS): requires the
   authoritative cloud/site/hybrid ownership contract review the issue itself puts first;
   no event emission was changed here so no new inconsistency is introduced.
3. **Periodic purchase credit-note posting** (5105/VAT/payable) — UI now gated with an
   explanation (above); the posting path is the follow-up.
4. **Exact-money API migration** for retail purchase endpoints (Rial decimal strings
   end-to-end): `item_purchases.total` is bigint and per-line totals are computed in
   `bigint`/`Decimal` already; changing the GET wire shape (`Number(p.total)`) touches the
   money-context contract shared by multiple sections and belongs with a coordinated change.
   Values ≤ `Number.MAX_SAFE_INTEGER` are exact today; the service layer already stores and
   sums exactly.
5. **Permission-gated UI controls** (`purchases.manage` awareness in both purchase
   sections), **server-side paginated purchase history** (replacing `LIMIT 100`), and the
   **retail purchase detail view** — UX work beyond the integrity scope.

## Quality gates run

- `npx tsc --noEmit` — clean.
- `npx vitest run` (unit suite) — 941 files / 12,437 tests passed.
- `npm run test:db` targeted suites (new files plus every suite touching the changed code):
  `retail-purchase-integrity` (new, 15), `supplier-return-lot-provenance` (new, 2),
  `retail-stock`, `retail-batch-inventory`, `operational-accounting`, `watch`,
  `f11-payables`, `negative-stock-settlement`, `retail-warehouse-document`, `holoo`,
  `sync-events` — all passed.
- `eslint --max-warnings=0` on every changed file — clean.
- `npm run build` — could **not** complete in the development sandbox: the webpack compile
  is OOM-killed at the sandbox's ~4 GB memory limit before reaching any source file
  (reproduced on unmodified deps; not caused by this change). CI's `test.yml` build gate
  verifies it on the PR.
