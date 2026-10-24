# POS overhaul — what changed, what was verified, what was not

Branch `arena/01a0cd79-cafe-restaurant-pos`, five commits on top of `7429b38`.
All thirteen numbered items are implemented. Every claim below is either a
command whose output is quoted, or is explicitly flagged as not tested.

---

## 1. Commands run, and their results

| Command | Result |
|---|---|
| `npx tsc --noEmit` | **clean** (exit 0) |
| `npm run lint` (`eslint . --max-warnings=0`) | **clean** (exit 0) |
| `npm run test:design` | **36 passed** |
| `npm test` | **393 files / 5645 tests, all passing** |
| `npm run build` | **succeeds** — compiled, 539 static pages generated |
| `npm run test:db` | **NOT RUN** — needs a Docker Postgres; Docker is not installed in this environment |
| `integration/**` (`vitest.db.config.ts`) | **NOT RUN** — same reason |
| `npm run test:visual` | **NOT RUN** — no browser binary is obtainable; `npx playwright install chromium` fails with `Download failure, code=1` and there is no system Chrome/Chromium |

Test-count arithmetic across the work: baseline **388 files / 5561** → after
removing the backdated feature **387 / 5544** → after the long-press tests
**391 / 5629** → after the filter-toolbar tests **392 / 5641** → final
**393 / 5645**. No pre-existing test was weakened, skipped or deleted except
the ones whose subject was deliberately removed (`itemizedSplit`,
`table.split`).

`npm run build` needs `NODE_OPTIONS=--max-old-space-size=7168` on this 3 GB
box — the default heap OOMs in the type-check worker *after* `✓ Compiled
successfully`. That is an environment limit, not a defect in this work.

### Live verification against a real database

Docker being unavailable, an embedded Postgres 16 (`npm run db:dev:start`) was
brought up, **210 migrations** applied, the seed loaded, and the app run with
`npm run dev`. Workflows were then driven over the real HTTP API with a real
session cookie. A 30-check regression script covering item 12 passed
**30/30**; the individual results are listed in §6.

---

## 2. Files changed

65 files, +4492 / −2975.

**New**
- `src/lib/hold-timer.ts`, `src/lib/haptics.ts` — long-press timing and haptics.
- `src/app/dashboard/hold-to-confirm-button.tsx`, `hold-repeat-button.tsx`.
- `src/lib/integrations/holoo/imported-sale-service.ts` — the back-dated write path the removed UI used to share.
- `src/lib/business-day.ts` (`businessDateOf`).
- Tests: `hold-timer.test.ts` (20), `haptics.test.ts` (10), `hold-to-confirm-button.test.tsx` (23), `hold-repeat-button.test.tsx` (29), `modifier-picker.test.tsx` (16), `filters.test.tsx` (12), `table-session-release.test.ts` (10), plus additions to `payment-draft.test.ts` (31).

**Deleted**
- `src/app/api/table-sessions/[id]/pay/route.ts`, `.../split/route.ts`.
- Six files implementing `ثبت سفارش گذشته` (panel, route, service, permission wiring, tests).

**Substantially rewritten**
- `src/app/dashboard/floor/session-panel.tsx` — 613 → 240 lines; all billing removed.
- `src/lib/table-session-service.ts` — `requestBill`/`closeSession`/`billToSplitLines` out, `releaseTableAfterOrderSettled`/`releaseSessionWithoutOrders` in.
- `src/app/api/orders/[id]/pay/route.ts`, `src/lib/payment-service.ts` — both checkout paths now release the table.
- `src/app/dashboard/payment-ways.tsx`, `src/lib/payment-draft.ts` — the `مبلغ دریافتی` redesign.
- `src/app/dashboard/orders/orders-list.tsx`, `src/app/dashboard/filters.tsx` — the mobile filter toolbar.
- `src/app/dashboard/pos/pos-screen.tsx` — compact phone header.
- `src/app/dashboard/modifier-picker.tsx`, `order-detail-modal.tsx`, `floor-plan.tsx`, `ui.tsx`, `table-sessions.ts`, `ai.ts`, `ai-tools.ts`.
- `vitest.config.ts` — `.tsx` tests, automatic JSX, jsdom per file.
- `docs/phases/Phase-3-…md`, `Phase-18b-…md` — superseded-notes, history left intact.

---

## 3. Obsolete code removed

**Back-dated order entry (item 3)** — UI panel, API route, service, permission,
labels, tests and KB entries. Historical orders, shared accounting and applied
migrations were left untouched, as instructed. The Holoo importer legitimately
needed the same back-dated write, so that path was extracted into
`imported-sale-service.ts` rather than deleted with the UI. Confirmed gone from
the served HTML of both `/accounting/orders` and `/accounting/pos`.

**Table-level billing (items 9 & 11)** — `POST /api/table-sessions/[id]/pay`
and `.../split`; `requestBill`, `closeSession`, `billToSplitLines`,
`itemizedSplit`; the PATCH actions `request_bill` and `close`; `SplitDialog`
and every payment control in the session panel; the `table.split` AI action
(its endpoint no longer existed); the orphaned `invalid_split` message.

**Kept after checking actual consumers, not assumptions** — `computeSessionBill`
and `evenSplit` still back the assistant's read-only `get_bill_split_preview`;
`completeOrderPayment` still serves the offline-sync handler
(`sync-domain-handlers.ts`), so it was extended rather than bypassed; floor
plan, seating, guest count, moves, merging, reservations and out-of-service are
all untouched.

**`bill_requested`** is now unreachable — nothing can set it. The enum value,
its style and its label are retained so rows written by the old flow still
render and can be moved out of that state; it was removed from the floor legend
and from the settable transition targets.

---

## 4. Exact long-press behaviour

**Payment confirm (item 5).** A single monotonic source (`performance.now()`
via `HoldTimer#clock()`) drives both the fill and the completion, sampled once
per animation frame. Submission requires an uninterrupted **4000 ms**; a tap
never submits and instead toasts «برای ثبت پرداخت، دکمه را ۴ ثانیه نگه دارید.».
Release, pointer-cancel, focus loss or the button becoming disabled/busy resets
to 0 %. `done` latches, so `onComplete` fires **exactly once**; context menu is
prevented and non-left mouse buttons are ignored. Mouse, touch, stylus and
keyboard all work. The fill is a real element — `data-testid="hold-progress-fill"`
with `role="progressbar"` — and the tests assert **its rendered width**, not
just the callback.

**Add-on buttons (item 6).** A tap adds **nothing**. A hold adds the first unit
at **2 s**, then one more every **2 s** (4 s → 2, 6 s → 3, 8 s → 4…) until
release or the group maximum, with the accent fill resetting to empty after
each increment. **Two taps within 320 ms** on an already-selected option
decrement by one; reaching 0 unselects it. A hold followed by a tap is never
mis-paired as a double-tap — this was a real bug, see §5. `maxSelect` counts
total units across options and stops a hold mid-flight; single-choice groups
switch instead of stacking; the persisted quantity is what `onConfirm` returns
and what «افزودن» prices. A contextual hint (`MODIFIER_HOLD_HINT`) and a
keyboard-reachable decrement provide the accessible alternative. Desktop is
visual only.

**Haptics.** Feature-detected (`supportsVibration()`); a buzz at press start,
at 25/50/75 % milestones, at completion, and a 10 ms tick per increment. All
durations ≤ 50 ms.

> **Vibration is not verified on a real device.** `haptics.test.ts` asserts
> only that requesting a buzz is always *safe* — absent API, non-callable
> `vibrate`, a refusing browser, a throwing WebView — and that the durations
> are within budget. No claim is made that a phone actually buzzed.

---

## 5. Defects found and fixed along the way

1. **Both long-press gestures were broken before this work.** `HoldTimer.now()`
   defaulted to `Date.now()` (epoch) while the buttons passed
   `performance.now()` (navigation origin). Depending on which won, a hold
   either never completed or completed instantly. Now regression-locked.
2. **The progress fill emptied at the moment of success.** Confirm-mode stayed
   `isHeld` after firing, so the teardown when the button disabled itself reset
   the fill to 0 % exactly when the cashier needed to see it full. Fixed by
   releasing before firing.
3. **Double-tap decrement died permanently on any option already added to.**
   `hold-repeat-button.tsx` classified "was that a tap?" using the *lifetime*
   `occurrenceCount`, so after the first hold every release looked like a hold
   and the decrement became unreachable. Fixed with a per-press
   `holdOccurrenceCount`. This was a live POS bug, not a test artifact.

---

## 6. Auto-release mechanics (item 10)

`releaseTableAfterOrderSettled(client, locationId, orderId, closedBy)` runs
**inside the checkout's own transaction**, immediately after the order reaches
`'completed'` — in `POST /api/orders/[id]/pay` *and* in `completeOrderPayment`,
so a sale that syncs up from a till that was offline leaves the floor in the
same state as a live one.

- **Trigger:** the session has no remaining order in `'open'` or `'held'`.
  Canonical order-finalization state — deliberately **not** cash-vs-total,
  which would re-derive occupancy from a number that legitimately differs from
  the bill (a credit sale leaves a balance, an overpayment leaves credit, a
  voided round is worth nothing) and would strand exactly the unusual
  checkouts.
- **Atomic:** the freed table and the settled bill commit together; a
  rolled-back checkout can never leave a table that looks empty but still owes
  money.
- **Concurrency-safe:** the session row is locked `FOR UPDATE` *before* the
  surviving orders are counted, so two cashiers settling the last two bills
  serialize and exactly the later one frees the table.
- **Idempotent:** the lock query filters `status = 'open'`, so a replay or a
  duplicate sync event finds nothing and stops.
- **Frees to `free`, not `cleaning`.** The old mandatory cleaning step made a
  paid table unsellable until somebody walked over to it. `cleaning` remains an
  **optional manual** transition, and `out_of_service` tables are never
  auto-freed (`AND status <> 'out_of_service'`).
- **Propagation:** a `table_session.updated` broadcast alongside
  `order.updated`, which the floor plan, waiter board and POS table picker
  already consume; the response also carries `tableReleased`.
- **Seated with nothing to settle:** `PATCH … { action: "release" }`, refused
  with `409 session_has_active_orders` while any order is live.
- **Multiple independent orders per table are preserved** — each settles on its
  own, and only the last one releases the table.

Ten unit tests in `src/lib/table-session-release.test.ts` pin the decision
itself: held counts as active, out-of-service is never freed, the lock precedes
the count, a takeaway order is a no-op, and closing is idempotent.

### Item 12 — regression pass, 30/30 against the live app

Takeaway checkout completes and releases no table · dine-in order seats its
table · settling the last order frees it (`tableReleased: true`) · **two orders
on one table: the first payment leaves the table seated, the second frees it** ·
multi-way (split-tender) checkout settles and frees · underpayment with a
customer settles as debt (`balanceDue: 425000`) and still frees the table ·
underpayment **without** a customer is refused `400 customer_required` and the
table stays seated · merging works and settling frees **both** merged tables ·
out-of-service refuses a new order and is never auto-freed · the shared retail
checkout route still resolves (it answers `403 industry_mismatch` because this
seed is food-service — the gate, not a crash) · `/accounting/{pos,orders,floor,
waiter,kitchen}` and `/dashboard` all render 200, including under a mobile user
agent · both deleted endpoints 404 · the retired PATCH actions 400 · no
back-dated-order string and no table-billing controls remain in the served HTML.

**One behaviour worth flagging:** *voiding* the only order on a table leaves it
seated. Voiding is not a settlement, and the party may well still be sitting
there, so releasing on a void would be a guess; the one-tap
«آزادکردن میز» covers it, and that path is verified.

---

## 7. Responsive improvements

**Mobile order filters (item 4)** — one `sm:hidden` single-row icon toolbar
(search, status, shift, table, date) composed from the existing shared filter
logic and primitives, with the desktop panel unchanged behind `hidden sm:block`.
Every slot is one `shrink-0` 44 px target, so additional filters scroll rather
than wrap and the row cannot overflow at 320/360/390/430 px. An active filter's
accessible name becomes «میز: میز ۴» and its value shows as a badge; «حذف این
فیلتر» appears inside a sheet only while that filter holds a value; the eraser
«پاک‌کردن همهٔ فیلترها» appears only while something is filtered. Search is a
button until tapped, stays expanded while non-empty, and collapses when its own
clear empties it. Twelve tests lock this, including the invariant that the
toolbar **owns no filter state** — opening and closing a sibling sheet cannot
disturb a set filter, and a filter cleared elsewhere shows as cleared. RTL and
safe areas preserved; order selection, other filters and scroll position are
untouched by a filter change.

**Compact POS header (item 8)** — on a phone the header padding drops to `p-2`,
the search row to 44 px and the category strip to a 44 px lane; from `md:` up
the desktop till is byte-for-byte unchanged. The strip is strictly
`flex-nowrap` with a hidden scrollbar and a negative margin so the first and
last chip reach the panel edge instead of looking clipped mid-scroll — it can
no longer grow a second and third line as the menu gains sections. The chips
now compose the shared `<FilterChip dense>` rather than re-deriving the amber
selected fill locally, which also gives them `aria-pressed`. The combobox
keyboard/barcode path (ArrowUp/Down/Enter, `searchActiveIndex`, the synchronous
recompute that avoids the barcode race, `aria-controls="pos-product-results"`)
is untouched.

---

## 8. Architecture and constraints (item 13)

No second payment component, no second source of truth for table occupancy, no
second order-details page. The remaining-balance calculation stays in the
payment system and was removed only from the modal footer, which now reads
«جمع کل · ۲ قلم — ۳۰۰٬۰۰۰ تومان». `مبلغ دریافتی` became a compact expandable
action beside «تقسیم بین چند روش» with three mutually exclusive modes — split,
collapsed, open-manual — so a stale typed amount can never double-charge; debt
and credit both still require a customer. Persian RTL, Shamsi-only dates,
tenant money unit, dark mode, offline safeguards, permissions and multi-tenant
isolation are all preserved; storage and API contracts remain integer Rial. No
new `withoutTenantScope()`, no new tenant-scoped table, and no
visual-regression baseline was re-recorded.

---

## 9. What was not verified

- **Real-device vibration** — not tested. Only the safety of the call is asserted.
- **`npm run test:db` and `integration/**`** — not run; no Docker.
- **Visual-regression / screenshots** — not run; no browser binary is
  installable here. Rendering was checked by fetching the served HTML from the
  running app and by reading the dev-server log for compile failures and
  `pageerror`, which is weaker than a screenshot and is not a substitute for a
  human looking at the phone layouts at 320/360/390/430 px.
- **Physical touch devices** — the pointer-level tests use realistic
  pointerdown/pointerup/pointercancel sequences in jsdom, not a real digitizer.
