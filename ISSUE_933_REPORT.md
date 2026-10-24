# Issue #933 — Settings → شیفت‌ها و روز کاری: cash-up, branch scope, closing and reliability

Implementation report for [`#933`](https://github.com/hamidnoshady/biza-miz/issues/933).

Scope was kept to the shift manager's own root causes. The shared reporting engine
remains #819's (`docs/mcp/coverage-matrix.md` was only regenerated, no report
metrics were added or changed), the Accounting Overview shift KPI semantics remain
#912's, and bank/ledger reconciliation (#830) was not touched.

---

## 1. What changed

### P0 — transactional and financial integrity

#### 1.1 A close is one transaction; a committed close never reports failure

`src/lib/shift-service.ts` — `openShift` and `closeShiftRow` now do all durable
work inside one `BEGIN … COMMIT`:

- the `employee_shifts` state change (`ended_at`, `closing_float`, `closed_by`,
  `close_mode`),
- the `shift_cashups` snapshot,
- the mandatory `audit_log` row (written with the same `PoolClient`, so it cannot
  be called outside the transaction by accident),
- the `sync_events` outbox event.

Notifications and the coworker event run **after** the commit, in a single
try/catch that cannot propagate: a push notification or a queue insert can no
longer turn a successful close into a 500. `recordCoworkerEvent` and
`recordNotification` keep their own swallow-and-log behaviour; the wrapper adds the
same guarantee for the code around them.

Retries:

- `POST /api/shifts/start` and both close routes honour `Idempotency-Key`.
  `employee_shifts.open_request_id` / `close_request_id` each have a unique
  `(business_id, key)` index. A start replay returns the shift that key already
  opened; a close replay returns the committed cash-up with `replayed: true`.
- A retried close finds its work **by key**, not by "is there an open shift" — so
  a self-close retry after commit cannot be mistaken for "nothing to close", and a
  fresh self-close with no open shift correctly answers `no_active_shift` instead
  of handing back the employee's last closed shift.
- Two concurrent closes with the same key serialize on `SELECT … FOR UPDATE OF s`;
  the loser re-reads the key under READ COMMITTED and returns the winner's
  snapshot. A *different* count for the same finalized shift is refused
  (`shift_already_closed`) because it is a correction, not a retry.
- The sidebar and the force-close form create one key per deliberate attempt and
  keep it across a retry, resetting it when the operator changes what they are
  asking for.

#### 1.2 A finalized cash-up is immutable; corrections are separate records

Migration `0233_shift_cashup_integrity.sql` introduces:

- `shift_cashups` — one row per shift (`UNIQUE (shift_id)`) with closing-time
  order count, gross, every tender class, opening/expected/counted cash, variance,
  cash in/out, closer, branch, business date, close mode, reason and a `breakdown`
  JSON document. A `BEFORE UPDATE` trigger (`app_shift_cashup_immutable`) refuses
  updates; the CHECK constraint makes an unresolved close impossible to store with
  a count or a variance.
- `shift_cashup_adjustments` — append-only, linked to the cash-up, with
  before/after variance, delta, mandatory reason, actor and timestamp.

`listShifts` reads the snapshot for a closed shift (`cashSource: "finalized"`) and
reports today's recomputation separately as `restated`, so an amendment, refund or
reversal after the close cannot silently change the signed-off variance while still
being visible to a reviewer.

`v_employee_shift_reconciliation` now prefers the snapshot and exposes
`cashup_id`, `cashup_status`, `cashup_at`, `restated_cash_total` and
`restated_variance` (columns appended; existing consumers unchanged). The Accounting
Overview's shift-variance finding (`accounting-review-service.ts`) reads the
snapshot too.

#### 1.3 Expected cash is explained, not assumed

- New `shift_cash_movements` (cash in/out with a mandatory reason, actor and
  branch; `BEFORE UPDATE` trigger) and `POST /api/shifts/[id]/movements`.
- `reconcileDrawer` (`src/lib/shift-cashup.ts`) computes
  `opening float + cash sales + cash in − cash out`, and returns `unresolved`
  whenever there is no baseline or no count.
- Only the `cash` tender feeds the drawer. `card`, `card_to_card`, `online`,
  `credit`, `snappfood` and `cheque` are reported but never added to expected cash.

**Deliberately deferred:** a first-class *till session* entity separate from staff
attendance (several people sharing one drawer), and tip-aware expected cash
(`orders.tip_amount` is not a `payments` row). The issue calls this a policy/design
defect; the data model and the snapshot now make the current rule explicit and
auditable, and the follow-up is a separate feature rather than a half-built second
shift model. See §5.

### P1 — branch authorization, data scope, permission parity

#### 1.4 The active branch is canonical

- `openShift` requires the resolved branch, verifies it belongs to the tenant and is
  active, and stores it directly. The session only supplies its id and device; it can
  no longer override the branch on screen (`coalesce(session.location_id, …)` was
  removed).
- `POST /api/auth/switch-location` refuses a switch while a shift is open at a
  different branch (`409 shift_open_at_branch` with the shift and branch ids), and the
  branch switcher now displays that reason instead of doing nothing.

#### 1.5 History and force-close are confined to reachable branches

`accessibleLocationIdsForUser` (`src/lib/setup-state.ts`) exposes the same
`location-access` rule every screen uses. `GET /api/shifts` and
`POST /api/shifts/[id]/close` pass that set to the service; `listShifts` filters on
it, and `closeShiftById` answers a shift outside it exactly like a missing one
(404, no existence leak). A direct id cannot cross the boundary.

#### 1.6 Legacy NULL-branch rows are attributed, not multiplied

`app_shift_attribution_branch(business, location, employee)` resolves a branch-less
row to exactly one branch: the shift's own branch → the employee's home branch →
their only `user_locations` assignment → the business's only active branch → **NULL**.

`src/lib/shift-branch-scope.ts` is the single SQL builder for that predicate and is
used by:

- business-day status (`business-day-service.ts`),
- the orders screen's window (`branchClosedOrdersWindow`),
- shift history (`listShifts`) and its filter options,
- the shift-orders report's shift picker (`shift-orders-service.ts`),
- the orders history filter (`order-history-service.ts`).

No query writes `location_id = $1 OR location_id IS NULL` any more. A shift that
cannot be attributed is reachable only through an explicit, all-branch audience —
never by one branch's manager.

#### 1.7 Permission parity

New capabilities (`src/lib/permissions.ts`, `permission-registry.ts`):

| key | meaning | presets |
| --- | --- | --- |
| `shifts.self` | clock myself in/out, count or not | manager, cashier, waiter, kitchen (+ owner/admin by rule) |
| `shifts.manage` | history, force-close, cash movements, corrections | manager (+ owner/admin) |
| `business_day.close` | close/reopen the branch's trading day | manager (+ owner/admin) |

- `/api/shifts/{start,end,active}` → `shifts.self` (was `orders.create`).
- `/api/shifts` and `/api/shifts/[id]/close` → `shifts.manage` (was `team.manage`).
- `/api/business-day/close` → `business_day.close` (was `ledger.close_period`). The
  manager's default preset never held that, which is why the panel's button could
  only 403.
- `GET /api/business-day` is readable by any active member (it is the day the
  dashboard is counting into) and returns `canConfigure`, `canClose` and
  `canReviewShifts` from the **same effective permission set** the routes enforce.
- The settings tab opens for any of `shifts.manage` / `business_day.close` /
  `settings.manage`; the panel hides the sections the caller cannot use.
- The sidebar's shift button is rendered from `shifts.self` only, so kitchen/waiter
  staff get a control that works and an accountant does not get a till control.
- No cashier/waiter/kitchen preset gained a ledger capability.

#### 1.8 Business-day close/reopen: atomic, idempotent, historical

- Close and reopen take a transaction-scoped advisory lock per branch
  (`pg_advisory_xact_lock`), read the status on the same client, and write the
  closure and its audit row in one transaction.
- `idx_business_day_closures_one_active` — a partial unique index on
  `(location_id, business_date) WHERE reopened_at IS NULL` — is the database-level
  guarantee that a branch-day cannot have two active closures.
- `Idempotency-Key` is stored as `request_id` (unique per branch); a retry returns
  its own closure.
- Reopen marks the identified row (`reopened_at`, `reopened_by`, `reopen_note`)
  instead of `DELETE`-ing every row in the scheduled window. It accepts an explicit
  `?closureId=`; without one it targets the closure holding the current window.
- The API returns `reopenEffects`, and the panel warns that reopening only resets
  the window: a `day_close` coworker event that already ran is not undone, and any
  automation that acted on it needs a compensating action.

#### 1.9 Every supported tender is explained

Shift totals now bucket `cash`, `card`, `card_to_card`, `online`, `credit`,
`snappfood`, `cheque` and `other`, plus `tendered_total`. `tenderTieOut` states the
difference between gross and tenders rather than hiding it (SnapFood, a cheque and
an amendment's superseded/negative rows are the ordinary reasons). A cheque is never
folded into cash.

#### 1.10 A force-close cannot invent a count

`shift-history-settings.tsx` no longer prefills "counted" with the expected figure.
The expected amount is read-only, the counted field starts empty, and there are two
explicit actions:

- **counted** — the operator typed what they physically counted (a difference
  preview is shown),
- **بدون شمارش (unresolved)** — requires a reason and a confirmation checkbox, and
  is recorded with NULL counted cash and NULL variance.

`parseShiftCloseInput` (pure, unit-tested) rejects arrays/primitives/`null` bodies,
fractional, negative or unsafe-Rial amounts, two different counts in one body, and
"without count" combined with a count. The service enforces the reason for every
administrative force-close even if another caller skips the route-level parse.

### P2 — operator experience, freshness, validation

- **History** gained filters for branch, employee, business-date range, shift id,
  "has a variance" and "closed without a count"; page order is
  `(started_at DESC, id DESC)` so offset paging cannot duplicate or skip rows that
  share a start second.
- **Rows** show the snapshot's expected/counted/variance, every tender class, cash
  in/out, close mode and reason, closer, adjustments with before/after values, and
  the restated figures when today's payments differ.
- **CSV export** of the loaded page in the business's display unit (BOM for Excel).
  PDF/XLSX and scheduled exports stay with the report engine (#819).
- **Drill-down** link to the shift-orders report for a closed shift.
- **Errors/empty/retry** states; concurrent filter/page reads are sequenced so an
  older response cannot overwrite a newer one.
- **Sidebar shift panel**: an unavailable status is a distinct state with retry (it
  used to look like "no shift" and then fail with `shift_already_open`), it reloads
  on `branch-switcher:changed`, keeps the open duration current, shows the running
  expected amount read-only, and its modal closes on Escape, keeps Tab inside,
  is `aria-modal`, focuses its input, and disables submission while busy.
- **Validation**: `isValidCashFloat` uses `Number.isSafeInteger` (matching the sync
  path) while keeping 0 valid; `readJsonObject` rejects malformed JSON, arrays,
  literal `null` and primitives with 400; UUID query parameters are guarded before
  reaching `uuid` columns.

---

## 2. Hybrid / offline

- Shift events are still emitted inside the shift transaction and replayed by id.
- `shift.opened` / `shift.closed` gained **schema v2**: `closeMode` and an optional
  `cashup` object (tender classes, expected/counted/variance, cash in/out, order
  count, gross, reason). v1 remains registered and accepted, so an in-flight event
  from a desktop that has not updated still applies. New events are always v2.
- A new event, `shift.cashup.adjusted` v1, carries an audited correction. It names
  the adjustment by id, inserts with `ON CONFLICT (id) DO NOTHING`, and defers
  (rather than dead-letters) when it arrives before its `shift.closed` event
  (`cashup_not_found`).
- The receiver inserts the snapshot with `ON CONFLICT (shift_id) DO NOTHING`, so a
  replay can never rewrite a finalized cash-up. The shift row keeps "closed wins":
  a late `opened` changes nothing.
- Cash *movement* detail stays local; the snapshot that travels carries their
  totals (in/out) and the tie-out, which is what a cloud report needs. A future
  movement-sync event is only worth adding if a cloud screen must list individual
  paid-outs.
- Device identity is deliberately **not** in the payload. `pos_devices` rows are
  device-local in the hybrid model, and the issue explicitly asks not to leak local
  session/device credentials. The branch is the event's own location, which the sync
  layer already authorizes; putting it in the payload would duplicate an identity
  the receiver must not take from the sender.

---

## 3. Migration, backfill and rollout

`migrations/0233_shift_cashup_integrity.sql` is additive and idempotent
(`IF NOT EXISTS`, guarded constraint):

1. `employee_shifts.open_request_id`, `employee_shifts.close_mode`,
   `employee_shifts_id_business_unique`, a branch/start index.
2. `app_shift_attribution_branch`.
3. `shift_cashups`, `shift_cashup_adjustments`, `shift_cash_movements` — all with
   `ENABLE/FORCE ROW LEVEL SECURITY` and the standard `tenant_isolation` policy.
4. `business_day_closures.reopened_at/reopened_by/reopen_note/request_id`; duplicate
   active closures (possible before the index) keep the newest and mark the rest
   superseded in the migration, so history is not deleted.
5. The partial unique indexes.
6. `CREATE OR REPLACE VIEW v_employee_shift_reconciliation` (same leading columns,
   five appended) with `security_invoker = on`.

**Backfill policy:** no historical cash-up is fabricated. A shift closed before this
release has no snapshot; it keeps the old live read, is labelled
`cashSource: "live"` / `cashup_status: "live"` and shows as "unresolved" when no
counter was recorded. A business that wants a historical variance finalized can
record a correction with a reason (audited) rather than have the product invent one.
Unattributed legacy rows are represented as unknown, not assigned to every branch.

Rollout: apply the migration, then deploy. The first release writes snapshots for
every new close; old rows remain readable throughout. No destructive step, no data
rewrite of money.

---

## 4. Verification

Run in this workspace:

| check | result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | **pass** (0 errors) |
| `npx eslint . --max-warnings=0` | **pass** (0 errors / 0 warnings) |
| `npx vitest run` (full unit suite, final run) | **960 files passed, 1 skipped; 12,615 tests passed, 7 skipped; exit 0** |
| `npx tsx scripts/write-mcp-coverage-matrix.mts` | regenerated (2 new routes, new permission columns) |
| `npx tsx scripts/write-mcp-verb-inventory.mts` | regenerated (`list_shifts`, `shift.start/end/close` now name the #933 keys) |

The first full run had exactly one failure: the committed MCP documentation no
longer matched the new permission map. Both documents were regenerated, the
MCP/AI subset was re-run (185/185), and the final full run above is green.

**Database integration tests were not executable in this environment** (no
`DATABASE_URL`, no PostgreSQL server). A new suite,
`integration/shift-cashup.integration.test.ts`, covers the cases that need a real
database and must run in CI:

1. close writes state + snapshot + audit + outbox together, and a start/close
   retried with its idempotency key returns the same row;
2. a payment inserted after the close changes `restated_*` but not the snapshot or
   the view's `cash_variance`;
3. an uncounted close stores NULL variance, and the CHECK constraint holds;
4. concurrent + repeated closes produce one snapshot and are replay-safe, a fresh
   close with no open shift answers `no_active_shift`, and a different count is
   refused;
5. cash movements change the expectation;
6. a supervisor's uncounted close needs a reason, and the audit records `forced`;
7. the snapshot refuses UPDATE; a correction is a linked row with before/after;
8. branch scope hides and refuses another branch's shift;
9. a legacy NULL-branch row is attributed to one branch only;
10. `openShift` uses the active branch, not the session's stale one;
11. business-day close/reopen: one active closure, history preserved, idempotency
    key replay.

Existing integration expectations were updated where the old "NULL belongs to every
branch" rule was asserted (`integration/shift-closed-orders.integration.test.ts`
now seeds a home branch, which is what makes its legacy-row case attributable).

New/updated unit tests:

- `src/lib/shift-cashup.test.ts` — tender buckets, drawer arithmetic, unresolved vs
  zero, close-body parsing and its error codes, adjustment arithmetic.
- `src/lib/shift-branch-scope.test.ts` — the predicate never contains
  `location_id IS NULL` and the allowed-branch check.
- `src/lib/request-json.test.ts` — arrays/null/primitives/malformed JSON, idempotency
  header.
- `src/lib/shift-sync.test.ts` — v2 cash-up round-trip, contradictory payloads
  refused, adjustment payload, schema version on the outbox row.
- `src/lib/shift.test.ts` — safe-integer bound, zero still valid.
- `src/lib/permission-matrix.test.ts` / `settings-tabs.test.ts` — the new presets and
  tab gating.
- `src/lib/notifications.test.ts` — variance text follows the tenant unit.

---

## 5. Known gaps and follow-ups

These are stated rather than half-implemented:

1. **Physical till sessions (#933 item 3).** A shift is still staff attendance
   attributed by `orders.closed_by`/`closed_at`. The snapshot, movements and audit
   make the figure explainable, but several cashiers sharing one register still need
   a first-class `till_sessions` entity with per-tender attribution to the session
   (using `payments.received_by`/`received_at`), opening carryover, transfers and
   handover. The current rule is now documented in `CLAUDE.md` and visible in the UI
   ("منبع ارقام").
2. **Tips.** `orders.tip_amount` is not a `payments` row, so a cash tip is not in
   expected cash. Until tips are modelled as a cash movement/tender, a shift with
   cash tips will show a surplus. This is called out here rather than silently
   folded into the sale.
3. **Report-grade exports.** CSV of the loaded page is implemented; PDF/XLSX,
   scheduled export and print templates belong to the report engine (#819).
4. **Overlap detection / notification escalation (#933 item 11).** "Closed without a
   count" and "has a variance" filters plus the open-shift duration make abandoned
   shifts visible; suspicious overlaps and escalation rules are not implemented.
5. **Browser/visual regression.** No deployed browser or production database was
   available here. The modal's focus trap, Escape and mobile layout are implemented
   but not visually regression-tested in this environment.
6. **Historical backfill of till/employee attribution.** Unknown stays unknown
   (NULL attribution) by design; no exact variances are manufactured.

---

## 6. Manual QA checklist

1. Branch A login → switch to B → open a shift: the shift shows B. With a shift open
   at B, switching back to A is refused with an explanation, and so is a direct
   `POST /api/auth/switch-location`.
2. Cashier opens a shift, records a ۲۰۰٬۰۰۰ paid-out with a reason, closes with a
   count: expected = float + cash − paid-out; variance is computed from that.
3. Close without a count: the history row says «بدون شمارش», variance is «نامشخص»,
   and no zero variance exists in the database.
4. Force-close as a manager without a count and no reason → 400 `reason_required`;
   with a reason → unresolved + audit `forced: true`.
5. After a close, amend a settled order in that window: the shift row's variance is
   unchanged; the restated line changes; the shift report's `cash_variance` is
   unchanged.
6. Record a correction with a reason: the original variance remains, the adjustment
   appears with before/after, and the audit has `shift.cashup_adjusted`.
7. As a manager scoped to Main, request history for Other (filter or direct id) →
   403/404; force-close Other's shift by id → 404.
8. Kitchen/waiter/cashier see «شروع شیفت» and it works; accountant does not see it.
9. Manager sees «بستن روز کاری» and it works; a member with only `settings.manage`
   sees the start time but no close button.
10. Double-click «بستن روز کاری» → one closure; reopen → row is marked reopened,
    history remains, and the panel warns about the queued `day_close` event.
11. Two branches, one legacy branch-less shift: only the branch it is attributable to
    has its window widened.
12. Offline desktop: open + close a shift, reconnect; the cloud shows the snapshot
    and variance; replaying the close does not duplicate or change it.
