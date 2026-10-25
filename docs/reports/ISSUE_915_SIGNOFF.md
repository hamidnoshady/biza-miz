# Issue #915 — sign-off: cloud-only purchase corrections, server-posted returns, and one manual purchase → receipt → return → report pass

**Scope of this change: verification only.** No product code, migration, UI or test was
changed. The branch adds (a) this sign-off, (b) one repeatable end-to-end pass script
(`scripts/e2e-purchases-915.mjs`) and (c) the evidence it produced
(`docs/audits/915-evidence/manual-pass.{log,json}`). Everything the two sign-offs below
claim is either already enforced by code that ships on `main`, or was observed directly in
the pass.

Run date **2026-10-25** · Node 22.22.3 · Next 15.5.28 · PostgreSQL 16.14 (414 migrations
applied) · server run as `DEPLOYMENT_ROLE=central PORT=3000 npm run dev`, i.e. the **cloud**
side of the sync link, which is the side the Accounting → انبار → خرید workspace is served
from.

---

## 1. The two sign-offs

> **A. FS purchase edit/order/cancel/delete stays cloud-only.**
> Signed off. Editing, ordering, cancelling and deleting an **unreceived** food-service
> purchase emit **no sync event at all**, and no screen renders that document on a hybrid
> desktop: `/accounting/inventory` is not a site-local route, so the desktop shows the
> cloud's page in `CloudPane`. The replicated facts of this domain remain exactly the two
> **effects** — `inventory.purchase.created` and `inventory.purchase.received` — and a site
> that pulls either acknowledges it without applying it, so no consumer can hold a stale
> draft, a ghost order or a deleted row.

> **B. Supplier returns stay server-posted.**
> Signed off. A supplier return exists only as the result of one server transaction:
> `POST /api/inventory/supplier-returns` → `createSupplierReturn` posts the journal entry
> (`postExactSupplierReturnEntry`), writes the stock movement, marks the `inventory_events`
> row posted and appends the sync-outbox event — all on the route's `PoolClient`. No client
> component carries posting logic, the outbox producer has no commit-separately overload,
> and the return's event is a cloud-owned effect class, so a desktop acknowledges a pulled
> copy instead of posting a second one.

Both statements were verified statically (code + pins), by the existing test suites, and
once end-to-end through the product's own HTTP surface; each body of evidence is below.

---

## 2. Sign-off A — purchase corrections are cloud-only

### 2.1 What the code does

| Where | What it establishes |
| --- | --- |
| `src/app/api/inventory/purchases/[id]/route.ts:101-113` | The decision itself, in the file: editing/ordering/cancelling/deleting an unreceived purchase "deliberately emit **NO** sync event", because they are cloud-only administrative corrections of a document with no stock or ledger effect. |
| same file, `PUT` (`:115`), `PATCH` (`:221`, non-receive branch), `DELETE` (`:300`) | None of the three imports or calls `appendSyncOutboxEvent`. The only outbox call in the file is the `sync:` object handed to `receivePurchaseInTransaction` on the receive branch (`:277`) — i.e. the **effect**, not the lifecycle. |
| `src/lib/sync-event-registry.ts:267,283` | The registry's whole `inventory.purchase.*` surface: `inventory.purchase.created`, `inventory.purchase.received`. There is no updated/ordered/cancelled/deleted type to emit. |
| `src/lib/purchase-service.ts:129-142` | `createDraftPurchaseInTransaction` records `inventory.purchase.created`. |
| `src/lib/purchase-receive-service.ts:56-66` | `receivePurchaseInTransaction` records `inventory.purchase.received`. |
| `src/lib/site-routes.ts:23` (`SITE_LOCAL_ROUTES`) | The list of screens a hybrid desktop renders locally — POS, orders, waiter, floor, kitchen, reservations, delivery, and this computer's own settings. `/accounting/inventory` is not in it. |
| `src/app/dashboard/deployment-capability-gate.tsx:41-42`, `src/app/dashboard/dashboard-main.tsx:35` | What that means in practice: a hybrid site renders every other screen through `CloudPane`, i.e. the **cloud's** page in the desktop's content area. There is no local purchase form, no local edit dialog, no local cancel button. |
| `src/lib/sync-event-registry.ts:67-83` | `inventory` is a cloud-owned effect class; `siteSkipsPulledEvent` answers true for it. |
| `src/lib/sync-events.ts:754-760` | Where that is applied: a pulled cloud event of a cloud-owned class is recorded as an applied `cloud_owned` effect and **not replayed** — before the actor check, because the cloud's back-office user need not exist on the desktop. |
| `src/lib/sync-event-registry.ts` — the single `offlineQueueEligible: true` row is `inventory.waste.recorded` (`:364`) | The client's offline queue cannot carry a purchase or a return at all: no purchase type is eligible, so no offline/reconnect replay can create, edit or delete one. |

`data-ownership.ts` still declares `inventory_movements` as `site_authoritative` /
bidirectional **for the events it produces**, which is the pre-Phase-45 shape of the domain
and is intentional: the effect travels with a real document, while the screen and the
document lifecycle are the cloud's. Phase 45's cloud-primary rule is expressed by the
**pull** side (`siteSkipsPulledEvent`), not by re-declaring the domain.

### 2.2 What pins it

- `src/lib/sync-event-registry.test.ts` — *purchase lifecycle ownership (issue #915)*:
  the registry's purchase events must equal `["inventory.purchase.created",
  "inventory.purchase.received"]`, and both must be `siteSkipsPulledEvent` = true. Adding a
  lifecycle event later therefore fails a test rather than silently shipping a dead event.
- `src/lib/site-routes.test.ts:29-52` — `/accounting/inventory` is explicitly asserted to be
  a **cloud** screen.
- `src/lib/data-ownership.test.ts` — every event the `inventory_movements` domain lists must
  exist in the registry (the test asserts `replicationContractProblems()` is empty), and
  financial/inventory domains may never take overwrite semantics.
- `src/lib/purchase-abilities.test.ts` — the mutation gate (`purchases.manage`) incl. staff
  and custom roles, so "who may edit" cannot drift from "who may see".

### 2.3 What the pass observed

Section 3 of `manual-pass.log`: a draft was created, ordered, edited while ordered, then
cancelled; a second draft was deleted with its lines. Afterwards the branch still held
**2 stock movements / 1 journal entry / 0 sync events** — the two movements and the one entry
being the earlier receipt. Section 6 repeated the whole lifecycle on a branch with a paired
desktop and got the same answer: **edit and order produced no event**, while the paired
branch's own create → receive → return produced exactly three (`inventory.purchase.created`,
`inventory.purchase.received`, `inventory.supplier_return.created`).

### 2.4 Residual boundary (stated, not hidden)

A site process is built from the same tree, so `src/middleware.ts` still serves
`/api/inventory/purchases/*` locally; it blocks only the *central-execution* paths
(`CENTRAL_EXECUTION_PATHS`) and the platform realm. The cloud-only guarantee for these
writes is therefore *by construction* — no local screen calls them, the hybrid desktop's
session lives in the cloud pane, and inventory-class effects are acknowledged rather than
applied — not by a server-side refusal on a site. A person who pointed a script at the
desktop's own port and its own session could write rows into the desktop's local database,
where they would neither propagate (the class is not applied) nor be read by any screen.
This is the same boundary the rest of the cloud-owned surfaces have and is not a regression
introduced by #915; it is recorded here so the sign-off is exact about what is enforced.

---

## 3. Sign-off B — returns are server-posted

### 3.1 One writer, one transaction

`src/app/api/inventory/supplier-returns/route.ts` is the only route that creates a supplier
return. It opens one transaction (`:13`), calls `createSupplierReturn(client, …)` (`:14`) and
commits (`:19`); on any failure it rolls back and answers 409 with the service's code. Inside
`src/lib/supplier-return-service.ts` the same `PoolClient` performs, in order:

1. the idempotency lookup (`:20-23`) — a repeated key returns the **original** document
   (`duplicate: true`) before anything is written;
2. the purchase row `FOR UPDATE` (`:24-27`) — serialises concurrent returns against one
   receipt;
3. the valuation of each line — from that line's own lot/cost allocation (perpetual), from
   the line's cost (periodic credit note), or the weighted-average carrying value;
4. the stock movement — a negative `supplier_return` movement (lot branch `:143-152`, the
   weighted-average branch `:104-121`), or no stock effect at all under ادواری (`:55-70`);
5. `postExactSupplierReturnEntry` (`:183`) — the balanced journal entry, goods value plus the
   cumulative VAT reversal read from the ledger;
6. `UPDATE inventory_events SET posting_status='posted'` (`:190`), so the inventory event
   and its posting status agree;
7. `appendSyncOutboxEvent(…)` (`:191-196`) on the *same* client, with the document's own
   payload (`purchaseId`, `settlementMethod`, `reason`, `lines`).

`src/lib/sync-outbox.ts:1-8` is explicit that there is no standalone-query overload, and why:
"making it impossible to commit an outbox row separately prevents the crash gap this module
exists to close." The event cannot outlive a rolled-back posting, and a posting cannot commit
without its event.

### 3.2 The client cannot post, and a site cannot re-post

- The purchase and return sections (`src/app/dashboard/inventory/purchases-section.tsx`,
  `src/app/dashboard/stock/purchases-section.tsx`, `src/app/dashboard/stock/returns-section.tsx`)
  contain no ledger/journal/posting code: they POST the document, send an idempotency key and
  render what the server returns (the retail returns screen shows a return's journal
  *read-only*, `returns-section.tsx:1585-1634`).
- `inventory.supplier_return.created` is registered with `effectClass: "inventory"`
  (`sync-event-registry.ts:291-304`), a cloud-owned class: a desktop acknowledges a pulled copy
  and does not apply it (`siteSkipsPulledEvent`, `sync-events.ts:754`). So the return's money
  and stock move exactly once — on the server that created the document.
- The retail engine's returns (`POST /api/stock/returns`) have the same shape on the server
  side: `createItemSupplierReturn` posts through `retail.*` posting rules with an idempotency
  key and a request hash, and the route refuses a missing key rather than inventing one.

### 3.3 What pins it

- `integration/f11-payables.integration.test.ts` (23 tests) — the purchase VAT posting and the
  supplier-return VAT reversal, plus the periodic credit note (issue #915) with full/partial
  and ceiling cases; every entry asserted balanced.
- `integration/supplier-return-lot-provenance.integration.test.ts` (6 tests) — per-line lot
  provenance, cross-line lot refusal, depleted lot under FIFO and LIFO, partial negative-stock
  settlement.
- `integration/retail-purchase-integrity.integration.test.ts` (26 tests) — idempotency
  (identical retry, key conflict, concurrent race), linked-return provenance and ceilings,
  settlement/VAT split, >2^53 Rial exactness, the concurrent linked-return race, and the
  posted-receipt correction guard added by migration 0234.

### 3.4 What the pass observed

Section 4 of `manual-pass.log`:

- The return posted **2,500,000** Rial of goods against the receipt plus **225,000** Rial of
  VAT reversal, and the server wrote the balanced entry
  `Dr 2100 2,725,000 / Cr 1300 2,500,000 / Cr 1220 225,000`.
- Lots fell from `10,000 g / 4,000,000` and `25,000 ml / 7,500,000` to
  `7,500 g / 3,000,000` and `20,000 ml / 6,000,000`; two negative stock movements
  (`-2,500 g`, `-5,000 ml`) carry the same values — the stock is gone, not edited.
- The purchase itself is untouched (still `received`, same 11,500,000 total).
- The `inventory_events` row is `supplier_return` / `posted`.
- An identical retry with the same key returned the **same document id** and `duplicate: true`,
  with the row counts still `1 return / 1 entry / 2 movements`.
- Over-return (8,000 g from a 7,500 g lot) → 409 `quantity_underflow`; a manipulated lot id →
  409 before any write.
- On the paired branch, the return's event was written by the server with
  `origin='local'`, `actor_role='owner'` and the document's own payload, and its cash entry was
  `Dr 1100 218,000 / Cr 1300 200,000 / Cr 1220 18,000`.

---

## 4. The manual pass — purchase → receipt → return → report

### 4.1 How it was run

```bash
# 1. an empty database with the full schema, on the repo's embedded Postgres
node scripts/dev-postgres.mjs --detach
#    (create the empty database, e.g. `pos915`, with any client, then:)
DATABASE_URL=postgres://pos:pos@localhost:5432/pos915 npm run db:migrate

# 2. the cloud side of the sync link, served by the app's own dev server
DATABASE_URL=postgres://pos:pos@localhost:5432/pos915 DEPLOYMENT_ROLE=central PORT=3000 npm run dev

# 3. the pass — it bootstraps the business itself, so it needs a fresh install
DATABASE_URL=postgres://pos:pos@localhost:5432/pos915 \
  node scripts/e2e-purchases-915.mjs --evidence docs/audits/915-evidence
```

The script exits 2 with an explanation when the database already has a user; recreate the
database rather than half-replaying a pass whose bootstrap has already happened.

The script starts where a real install starts — the first-run bootstrap with
`industry: food_service` (that is what writes the business's industry), then the wizard's own
chart-of-accounts, costing (FIFO, perpetual) and tax (9%) endpoints, then two ingredients with
purchase units (kg→g, L→ml) and one supplier. Every subsequent action is an ordinary HTTP call
with the bootstrap session and an `Origin` header, i.e. the same routes the screen calls. The
only fixture that is not a product endpoint is the `site_devices` row that simulates a desktop
paired to the branch in section 6 (created and removed inside the script) — pairing itself is
not what this pass verifies.

### 4.2 What was exercised, and the numbers

| Step | Document | Result observed |
| --- | --- | --- |
| Draft | 10 kg flour (4,000,000) + 20 L milk (6,000,000), invoice `INV-915-1`, 9% VAT | 10,000,000 total; **no** stock, lot or journal row |
| Edit | milk → 25 L (7,500,000), VAT 1,035,000, note edited | 11,500,000 total; lines stored as 10,000 g @400 and 25,000 ml @300 |
| Order | — | `ordered_at` set; still no effect |
| Receive (credit) | — | stock 10,000 g/4,000,000 + 25,000 ml/7,500,000; two FIFO lots; balanced `Dr 1300 11,500,000 + Dr 1220 1,035,000 / Cr 2100 12,535,000`; `inventory_events` posted |
| Correct a received receipt | PUT / PATCH-cancel / DELETE | 409 `purchase_received_cannot_edit` / `invalid_transition` / `purchase_received_cannot_delete`, nothing changed |
| Cancel / delete drafts | — | cancelled and deleted; no stock, no entry, no event |
| Supplier return | 2,500 g flour + 5,000 ml milk, A/P settlement | 2,500,000 goods + 225,000 VAT = `Dr 2100 2,725,000 / Cr 1300 2,500,000 / Cr 1220 225,000`; lots 7,500 g/3,000,000 and 20,000 ml/6,000,000 |
| Retry / over-return / wrong lot | — | replay (`duplicate: true`, same id) / 409 `quantity_underflow` / 409 before any write |
| History | `GET /api/inventory/purchases?status=received` | totals `count 1`, goods 11,500,000, VAT 1,035,000 |
| History CSV | `?format=csv` | UTF-8 BOM, RFC-4180, exact Rial digits, `INV-915-1`, Shamsi `۱۴۰۵/۰۷/۲۶` |
| «خرید به تفکیک تأمین‌کننده» | standard report | received row = 11,500,000; the cancelled 800,000 draft keeps its `cancelled` status (see finding F1) |
| «ارزش‌گذاری موجودی» | standard report | flour 3,000,000 + milk 6,000,000 |
| Stock levels | `/api/inventory/stock-levels` | 7,500 g and 20,000 ml, total value 9,000,000 |
| Ledger | 1300 / 1220 / 2100 from posted lines | 9,000,000 / 810,000 / −9,810,000 — the GL agrees with the stock screen to the Rial |
| Paired branch | one SKU on two lines (1 kg @400,000 + 2 kg @1,000,000), cash, VAT 126,000 | two distinct lots for the same item; cross-line lot → 409 `supplier_return_lot_mismatch`; half of the cheap line returns 200,000 + 18,000 VAT = `Dr 1100 218,000 / Cr 1300 200,000 / Cr 1220 18,000`; exactly three sync events for create/receive/return, none for edit/order |

**Result: 53 / 53 checks passed, exit 0.** Evidence:
`docs/audits/915-evidence/manual-pass.log` (the transcript) and `manual-pass.json` (every
check with its detail, plus the rows behind the numbers — journal lines, lots, movements,
report rows and sync-event payloads).

### 4.3 How faithful this is

- **Faithful:** the same Next.js server, the same Postgres schema (414 migrations), the same
  session cookie and `Origin` check, the same handlers the browser calls, and the resulting
  rows read back out of the database.
- **Not exercised: the rendered UI.** No Chromium is available in this sandbox, so no browser
  automation ran; the pass proves the route contract, the posting and the data, not the pixel
  layout. The screen's own behaviour is covered by the repository's unit/design suites, and
  nothing in this change touches it.
- **RLS was not enforced during the pass**: the sandbox's database role is a superuser
  (the server warns about exactly this on boot), so row-level security was a no-op. Tenant
  isolation is covered by the integration suites (e.g. the cross-tenant 404 in
  `integration/retail-purchase-detail-route.integration.test.ts`), not by this pass.

---

## 5. Quality gates run for this change

| Gate | Result |
| --- | --- |
| The pass itself (`node scripts/e2e-purchases-915.mjs`) | **53/53 checks, exit 0** — on a freshly migrated database |
| `npx vitest run` — the suites that own these contracts: `sync-event-registry`, `site-routes`, `data-ownership`, `purchase-abilities`, `purchase-lines`, `standard-report-service`, `reports`, `api/inventory/purchases/route`, `api/stock/returns/route`, `api/stock/returns/[id]/route` | **10 files / 151 tests passed** |
| `npx vitest run --config vitest.db.config.ts integration/f11-payables.integration.test.ts` | **23 passed** (205 s) |
| … `integration/supplier-return-lot-provenance.integration.test.ts` | **6 passed** |
| … `integration/retail-purchase-integrity.integration.test.ts` | **26 passed** |
| `npx eslint --max-warnings=0 scripts/e2e-purchases-915.mjs` | clean |
| `npx tsc --noEmit` | **could not complete in this sandbox** — the OOM killer terminated `tsc` at ~3.5 GB RSS on a 3.9 GB box (three attempts, incl. `--max-old-space-size` 3.0–3.5 GB; `dmesg` shows `Out of memory: Killed process … (node)`). The same sandbox ceiling is already recorded for `npm run build` in `docs/plans/ISSUE_915_PLAN.md`. This change adds **no TypeScript** — only a `.mjs` script, its evidence and this report — so nothing here can alter the type graph; CI covers it: on PR **#1144** the **type check passed** (2m45s) and the **production build passed** (5m24s). |

All 19 checks on PR #1144 are green — type check, production build, unit tests, ESLint,
design checks, the six real-database integration shards, visual regression, media E2E, data
transfer, API guard and the web/android bridge jobs — so the two gates that cannot run in
this sandbox are confirmed by CI on this exact tree.

---

## 6. Findings reported, not fixed

**F1 — «خرید به تفکیک تأمین‌کننده» includes cancelled purchases at face value.**

The standard report is a row dump of `v_purchase_summary`
(`src/lib/reports.ts:1236-1252`), and that view deliberately keeps **every** status —
its definition in `reports.ts:477-479` says so ("All statuses are present; filter on status for
received-only spend"). The report definition however sets no default status filter, and its
description promises only «خریدهای ثبت‌شده و تحویل‌نشده» (placed and undelivered). A
**cancelled** draft is neither, but it is summed like spend: the pass's cancelled 800,000 draft
appears beside the received 11,500,000 row, and a reader who sums the `cost` column overstates
by exactly the face value of every cancelled document. (The received-only row is correct, and
each row does carry its own `status`.)

This is a report-semantics question (filter in the report definition, filter `cancelled` in
the view, or say so on the screen), it is outside the two sign-offs and the one pass this
task asked for, and it must not be changed casually — `v_purchase_summary` backs custom
reports and the purchases screen's own filters. **Reported here; left open as a follow-up
(AGENTS.md rule 6/7).** The pass asserts the behaviour as it is (received row = the receipt;
cancelled row keeps its status) so the finding is reproducible.

**F2 — error granularity for a manipulated lot id (observation only).** Naming another
*item's* lot against a line answers `supplier_return_lot_not_found`; the more precise
`supplier_return_lot_mismatch` is reserved for the same item on a different line. The pass
exercises both (section 4 and section 6). Behaviour is correct in both cases — the lot is
refused before any write — so this is a message-shape observation, not a defect.

---

## 7. What this sign-off does not claim

- It does not re-open the #915 implementation work; it verifies the two decisions the follow-up
  asked to sign off and runs one pass over the shipped flow.
- It does not cover the **periodic** (ادواری) engine beyond the fact that the append entry
  exists and its tests pass — the pass ran on the perpetual system, where the receipt, lot and
  return behave end-to-end. The periodic credit note is covered by
  `f11-payables.integration.test.ts`.
- It does not cover the **retail** (`items` / `item_purchases`) engine end-to-end over HTTP;
  that engine's integrity is covered by `retail-purchase-integrity` (26 tests) and the detail
  route's cross-tenant test, which ran green here.
- It does not cover UI rendering, RLS enforcement (see §4.3), or any deployment other than the
  cloud role used for the pass.
