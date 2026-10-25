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

- Migration `0246_item_purchase_idempotency.sql`: `item_purchases.idempotency_key` +
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

## Phase 2 — the items deferred above, now shipped in this same PR

Every item from the original "Deferred" list is now implemented (or carries an explicit,
documented decision). The decisions, in the deferred list's numbering:

1. **Retail settlement & supplier invoice** — `POST /api/stock/purchases` takes
   `settlementMethod` (`credit` default — the historical behaviour — plus `cash`/`bank`)
   and the same `invoice` block as F&B (`parseSupplierInvoice`): number, date, VAT,
   terms/due date. Migration `0233` adds the columns; the posting rule
   (`retail-stock-posting-rules.ts`) credits the *chosen* settlement account
   (1100/1120/2100) for goods + VAT and debits 1220 for the VAT — an absent field posts
   exactly as before. Tests per method and for the VAT split live in
   `integration/retail-purchase-integrity.integration.test.ts`.
   **Product decision — no draft → ordered lifecycle for the `items` model:** retail
   receiving stays receive-immediately. The lifecycle exists in F&B because kitchens order
   ahead against recipes; the retail industries here (cosmetics/accessories/watches) buy
   and shelve in one act, and a second document state machine would duplicate the F&B one
   the issue says to keep separate. The issue allows exactly this trade
   (settlement + invoice fields shipped, decision documented).
2. **FS purchase edit/order/cancel/delete — cloud-only, by decision.** Stock is
   cloud-owned since Phase 45: `/accounting/inventory` is not in `SITE_LOCAL_ROUTES`
   (a hybrid desktop renders it from the cloud, so there is no local mutation surface to
   hide), and a site acknowledges pulled inventory-class events without applying them.
   The replicated facts are the *effects* (`inventory.purchase.created/received`,
   `inventory.supplier_return.created`); draft-lifecycle corrections are cloud-only edits
   of a document with no stock/ledger effect and deliberately emit no event. Documented on
   the route (`/api/inventory/purchases/[id]`) and pinned both ways in
   `sync-event-registry.test.ts` (exactly those purchase events exist; both site-skipped).
3. **Periodic credit note** — `createSupplierReturn` now has a periodic branch: value
   comes proportionally off the receipt line (same cumulative ceiling as perpetual,
   `quantity_underflow` past it), the entry posts Debit settlement / Credit 5105
   «خرید طی دوره» plus the proportional VAT reversal, and NO lots/stock movements are
   touched (the period-close count restates 1300). `supplier_return_lines` allows NULL
   lot/movement (migration `0233`) with a partial unique index guarding one line per
   (return, item). The FS UI un-gates the return button for received periodic purchases
   and explains the credit-note semantics. Tests: full/partial/VAT-remainder/ceiling in
   `integration/f11-payables.integration.test.ts`.
4. **Exact money on the retail wire** — the purchase GET/POST and detail route never pass
   a Rial through `Number()`: totals, VAT and unit costs are decimal text end to end
   (`money.parseText`/`formatText` in the UI, `/^\d{1,19}$/`-validated text or safe
   integers at the route, `bigint`/`Decimal` in the service). Proven past 2^53 (2^53+1
   survives document → stock → journal exactly) in the integration suite; malformed
   costs/dates/UUIDs/bodies are stable coded 400s (route unit tests).
5. **`purchases.manage` gating, server-side history, retail detail** — both purchase
   sections hide all mutation controls unless the effective permission set grants
   `purchases.manage` (`src/lib/purchase-abilities.ts`: an explicit permission list — even
   empty — is authoritative; preset fallback owner/admin/manager); the retail history is
   server-side filtered (supplier, Jalali date range) and paginated (50/page,
   `queryReportPage`) replacing `LIMIT 100`; `GET /api/stock/purchases/[id]` serves the
   full receipt (header, settlement, invoice, lines with batch/serial provenance) behind
   an expandable row with retry + stale-response guards (same pattern added to the FS
   detail fetch).
   Note: the retail *returns* section stays ungated by `purchases.manage` on purpose —
   its route authorises `inventory.adjust`, and the UI mirrors the server's actual check.
6. **Returns idempotency** — `POST /api/stock/returns` now *requires* the client key
   (8–128 chars; its only caller already sent `crypto.randomUUID()`), so no silent
   server-generated fallback can mask a retry. OCR metadata merge is unit-tested
   (`ocr-invoice-merge.test.ts`): clamps, keeps user-typed values, leaves VAT/terms alone.

## Phase 3 — follow-up hardening shipped in this same PR

Each item is either implemented or carries an explicit product decision:

1. **Purchase-history filters, totals and CSV (both engines).**
   `GET /api/stock/purchases` adds `status`, `invoiceNumber` (substring, LIKE-escaped),
   `itemId`/`sku` filters on top of the phase-2 supplier/date/page set;
   `GET /api/inventory/purchases` moves from `LIMIT 100` to the same
   `queryReportPage` pagination (50/page) and adds `invoiceNumber`/`itemId` filters
   (and stable coded 400s for malformed supplier/date/page input, which previously
   surfaced as raw Postgres cast errors). Both GETs return the filtered set's
   totals (`count`, goods, VAT — exact text, same DB snapshot as the page) and both
   accept `?format=csv` for a full filtered export (UTF-8 BOM, RFC-4180 quoting,
   formula-injection guard, **Shamsi dates**, exact Rial digits). Both sections
   expose the new filters, the totals line and the export button.
   **Product decision — no warehouse filter on the retail list:** the retail engine
   has no warehouse master table; stock is scoped per branch
   (`item_stock.location_id` — the branch IS the warehouse) and the history list is
   already branch-scoped. Inventing a warehouse dimension here would contradict the
   issue's "keep the two inventory models separate" directive.
   **Product decision — `sku` filter is retail-only:** retail `items.sku` is a real
   scannable identity, while F&B `inventory_items.sku` is only a search hint
   (migration `0097`'s own words); the FS list therefore filters by `itemId`
   (ingredient picker in the UI), which is the meaningful equivalent there.
2. **Posted-receipt correction policy (retail).** A posted `item_purchases` receipt
   is corrected only by a NEW document — supplier return or (periodic) credit note —
   never edited or deleted. Migration `0234` enforces it in the database: a BEFORE
   UPDATE/DELETE trigger allows exactly the receive transaction's own total
   finalisation (`total` still 0 and only `total` changing, compared via `to_jsonb`
   so future columns are covered), rejects every other UPDATE, and rejects DELETE
   from tenant-scoped sessions (`app.business_id` set) while letting FK cascades
   (business/branch offboarding) and GUC-less maintenance sessions pass. What the
   operator gets instead is a **print-ready receipt copy**
   (`purchase-receipt-print.ts`, unit-tested: HTML-escaped, Shamsi, exact text money)
   and the CSV export above. Integration tests cover allowed/blocked UPDATE, blocked
   tenant DELETE, cascade pass-through.
3. **OCR grand-total cross-check.** `ocrGrandTotalMismatch` (ocr-invoice-merge.ts,
   bigint — exact past 2^53, unit-tested for mismatch/agreement/large totals) compares
   the scanned invoice's printed grand total against the draft's lines + VAT, live as
   the operator edits. A mismatching draft cannot be submitted until the operator
   ticks an explicit approval; fixing the figures dissolves the warning; a scan with
   no readable grand total checks nothing (unreadable ≠ mismatch).
4. **Adversarial/concurrency tests added.** Retail: two concurrent linked returns
   (6+6 against a 10-unit receipt) — the purchase row lock admits exactly one, stock
   and cumulative quantities prove it; cross-tenant
   `GET /api/stock/purchases/[id]` against a real database (f11's session-mock
   pattern) answers 404 for a foreign receipt, exact text money for one's own. FS:
   depleted-lot of a repeated-SKU purchase under BOTH fifo and lifo (not offered by
   the resolution query, `quantity_underflow` when forced, sibling lot still
   returnable), a receipt that partially settled a negative balance (only the
   residual lot returnable, exact split 2/3 + 200/300), and manipulated lot ids
   (another tenant's lot, random UUID → `supplier_return_lot_not_found`).
   Permissions: staff (cashier/waiter/kitchen) and custom-role cases in
   `purchase-abilities.test.ts`; route-level 403 (service untouched) in the stock
   purchases route tests.
5. **Idempotency key survives reloads.** `src/lib/pending-idempotency.ts`
   (unit-tested): the retail purchase and return forms persist the pending key in
   `sessionStorage` under a fingerprint of the exact payload until the outcome is
   known — a reload between "sent" and "answered" resubmits with the SAME key (the
   server replays the original document), a changed payload gets a fresh key, success
   clears the entry, a 409 (key spent on another payload) drops the stale entry, and
   unavailable/corrupted storage degrades to the previous per-mount behaviour.
6. **Migration-number collisions — verified safe, deliberately not renumbered.**
   `scripts/migrate.ts` tracks applied migrations by FULL FILENAME and orders
   lexically, so same-number/different-name files coexist. Survey of all open PRs
   (2026-10-20): 0232 is also used by #1022/#1026/#1027/#1030/#1032, 0233 by
   #1018/#1024/#1028/#1029/#1031/#1034/#1035/#1036, 0234 by #1019 — every filename is
   distinct from ours (`0246_item_purchase_idempotency`,
   `0247_item_purchase_settlement_periodic_credit_note`,
   `0248_item_purchase_correction_guard`), so any merge order applies each file
   exactly once. Renumbering is the one unsafe move (a renamed, already-applied file
   would re-apply), so the duplicate numbers stay.

## Quality gates run

Phase 1:

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

Phase 2 (same gates, re-run on the full tree):

- `npx tsc --noEmit` — clean.
- `npx vitest run` (full unit suite) — 943 files / 12,460+ tests passed (includes the new
  route tests, `purchase-abilities`, `ocr-invoice-merge`, the rewritten
  `periodic-system-guards` and the sync-registry ownership pins; the MCP coverage matrix
  was regenerated for the new detail route).
- `npm run test:db` targeted: `retail-purchase-integrity` (22 — settlement per method,
  VAT split, >2^53 exactness), `f11-payables` (23 — periodic credit note full/partial/VAT
  remainder/ceiling), `supplier-return-lot-provenance`, `retail-stock`,
  `retail-batch-inventory`, `retail-warehouse-document`, `negative-stock-settlement`,
  `operational-accounting`, `watch`, `accessories`, `holoo`, `sync-events` — all passed.
- `eslint --max-warnings=0` on every changed file — clean.
- `npm run build` — still not runnable in this sandbox (same ~4 GB OOM); CI's build gate
  covers it on the PR.

Phase 3 (same gates, re-run on the full tree):

- `npx tsc --noEmit` — clean.
- `npx vitest run` (full unit suite) — 953 files / 12,562 tests passed (includes the new
  `pending-idempotency`, `purchase-receipt-print`, OCR grand-total cross-check,
  filter/totals/CSV route tests and `purchase-abilities` staff/custom-role tests; no new
  route files, so the MCP coverage matrix is unchanged and its check passes as-is).
- `npm run test:db` targeted: `retail-purchase-integrity` (26 — adds the concurrent
  linked-return race and the migration-0234 guard proofs), new
  `retail-purchase-detail-route` (3 — real-DB cross-tenant 404),
  `supplier-return-lot-provenance` (adds fifo+lifo depleted-lot, partial
  negative-settlement residual and forged-lot-id tests), `f11-payables`, `ap`,
  `retail-stock`, `watch`, `retail-batch-inventory`, `retail-warehouse-document`,
  `negative-stock-settlement`, `accessories`, `holoo`, `operational-accounting` — all
  passed against the fully migrated schema including 0234.
- `eslint --max-warnings=0` on every changed file — clean.
- `npm run build` — still not runnable in this sandbox (same ~4 GB OOM); CI's build gate
  covers it on the PR.
- CI size budget (root-caused and fixed at the owner's direction): the desktop
  `packaged Windows end-to-end` job failed on its **unpacked size budget**, not on any
  test — the hard 644 MiB gate was already 99.97% consumed by main itself (643.817 MiB,
  run 39405675854, ~190 KB headroom for any branch). This branch's legitimate compiled
  `.next` output (+0.195–0.279 MiB for the new purchase routes/UI; composition verified
  by the packaged-payload diagnostics — no node_modules/caches/source maps) measured
  644.012–644.096 MiB, and one same-SHA run passed at the same boundary (measurement
  noise around an exhausted budget). Per the workflow's own documented protocol (fresh
  byte-accurate base/head measurement + owner sign-off, as in the 620→640→644 moves),
  the gate moved 644→**646 MiB** on 2026-10-20 at Hamid's direction in PR #1023,
  restoring the same ~1.9 MiB headroom the #993 move restored. The installer gate
  (165.3–165.4 against 175 MiB) is untouched.
