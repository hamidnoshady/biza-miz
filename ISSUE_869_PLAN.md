# Issue #869 — Commission run approval, settlement and payout lifecycle — implementation plan

Working branch: `arena/40246fe8-biza-miz` (from `main` at `7b1b11c`). Committed to this branch; no pull request, not merged.

Scope from the issue: complete the commission financial lifecycle *after accrual*.
Commission rules, seller assignment, effective dates, accrual posting and the rules-and-report
screen (#764) are not rebuilt. Payroll's own commission settlement and the 2300 tie-out (#835,
migration 0215) are extended, not replaced. #869 owns run → approval → settlement → payout.

## Baseline, before the first change

- `npx tsc --noEmit` clean, with `NODE_OPTIONS=--max-old-space-size=3072` (the CI setting; the
  default heap runs out during the check).
- Unit suite `npx vitest run`: 698 files, 9175 tests, all passing.
- `integration/commission.integration.test.ts` (10) and `integration/payroll.integration.test.ts`
  (184): 194 tests passing against embedded Postgres.
- Local Node is 22; the repo and CI target Node 24. The `npm ci` warnings are `EBADENGINE`.

## Phase 1 — schema, and one claim for both settlement paths

- [x] Migration `0216_commission_settlement.sql`: runs, immutable line snapshots, carry-forwards,
      payouts, allocations and events. Tenant isolation (`ENABLE` and `FORCE ROW LEVEL SECURITY`,
      policy `tenant_isolation`) on all six tables, in the same migration.
- [x] Guards: run identity cannot change; lines are never edited and leave only by cascade or by a
      reject (a transaction flag); carries change only their claim; payouts, allocations and events
      are append-only.
- [x] `commission_accruals.settlement_run_id`, and `commission_accruals_one_claim`
      (`payroll_run_id IS NULL OR settlement_run_id IS NULL`). An accrual is claimed once, ever.
- [x] Payroll's claim paths exclude standalone claims: `collectCommission`, the claim `UPDATE`
      (row count checked), and the unclaimed figure in `getPayrollLiability`.

## Phase 2 — the rules, as pure code (unit-tested)

- [x] Lifecycle table: statuses, actions, the permission each needs, what a status allows,
      separation of duties (`mayApproveRun`: the calculator cannot approve), and the reject and void
      policy (`REJECT_TO_DRAFT_ALLOWED`).
- [x] Planner: eligible rows, the positive-net rule (a member is paid only when net is above zero),
      carry-forwards, the rule snapshot with a 16-hex `rule_version`, and the warnings.
- [x] Payout allocation (`planAllocations`): never above what a member is owed in the run; «everything
      owed» resolved on the server; a request fingerprint (`payoutRequestHash`) that a retry must match.
- [x] Strict input parsing (integer Rial, real calendar dates, bounded lists, keys) and the CSV
      exports (Shamsi dates through `formatJalali`, the business's display unit, formula-safe cells
      through the shared `toCsv` codec).

## Phase 3 — transitions and money (integration-tested against Postgres)

- [x] Create, calculate, review, approve, reject, release, void and close. Each writes an event and
      an `audit_log` row in the transaction that changes the run.
- [x] Payouts post once: Dr 2300 / Cr cash or bank, idempotent on `Idempotency-Key`, refused beyond
      outstanding, and refused for an account that is not a payment account.
- [x] Reversal posts a mirror entry, negates the allocations, happens once per payout, and is refused
      once the run is closed.
- [x] Each payout and reversal appends a business-scope sync event in the same transaction as its money
      (`commission.payout.recorded@1`, `commission.payout.reversed@1`; migration 0217).
- [x] Closing a part-paid run carries each member's remainder; the next run claims it exactly once;
      rejecting or voiding the claiming run releases it.
- [x] The 2300 tie-out, in two identities, both zero at every step of the integration test.

## Phase 4 — permissions and the HTTP surface

- [x] Keys `commission.calculate`, `commission.approve`, `commission.payout`, `commission.reverse`;
      each implies `commission.view`. Manager receives calculate; accountant receives all four;
      owner and admin receive everything.
- [x] Every new route is declared in `GROWTH_API_PERMISSIONS`. `growth-access.test.ts` compares the
      declared keys with each handler's source, so a drift fails the suite.
- [x] Route tests (`commission-routes.test.ts`, 20): each route's permission, body validation, the
      `Idempotency-Key` header, refusals with their codes, and CSV downloads.
- [x] A Persian sentence for every refusal code the settlement code raises
      (`commission-settlement-messages.test.ts`).

## Phase 5 — the screens (Growth, under the commission section)

- [x] Runs list: the 2300 tie-out card, create-and-calculate, status filter, paging, CSV export.
- [x] Run detail: warnings, the actions this person may take (destructive ones confirmed; a void
      needs a reason), members, the payout form (idempotent, with «everything owed» per member),
      payouts with reversal and journal links, the source-line drill-down (sale, order, item, rule,
      journal entry, CSV), the member statement, and the event trail.
- [x] A separate approval-summary card (`ApprovalSummaryCard`): the run's totals, its warnings, who did each step, and the event trail.

## Phase 6 — documentation and the gates

- [x] `docs/commission-settlement.md`: the lifecycle, what a run contains, paying and reversing, the
      reconciliation identities, the permissions, the API, and the decisions and gaps below.
- [x] This plan. The payroll tie-out comments are updated to the new meaning of «unsettled».
- [x] Gates run on the final state; results in the Gates section below.

---

# Status

Delivered on branch `arena/40246fe8-biza-miz` and committed there; not merged. The table maps each requirement of the
issue to the code that meets it and to the test that proves it.

## What each part of the issue maps to

| Issue requirement | Where it is met | Proven by |
| --- | --- | --- |
| Authorised roles create a run for a date range or pay period, with eligible accruals, selected sellers and a branch filter | `commission-settlement-service.ts` (`createCommissionRun`, `loadCandidates`) | integration: "snapshots the unclaimed accruals…"; unit: planner tests |
| Snapshot: accruals, rule ids and versions, source sales, seller, basis, amount, reversals, total payable | `commission_settlement_lines` (immutable), `rule_version`, `rule_terms` | integration: calculate test; unit: planner tests |
| Later rule edits must not rewrite a run | line snapshot columns; the rule fingerprint is used only by later runs | the line guard in the schema; calculate test |
| draft → calculated → reviewed → approved → payable → partially paid / paid → closed | `commission-settlement-lifecycle.ts` | unit: lifecycle tests; integration: approval, payout and close tests |
| Reject back to draft where policy permits; void before posting | `rejectCommissionRun`, `voidCommissionRun`, `REJECT_TO_DRAFT_ALLOWED` | integration: "rejects a calculated run back to draft…" |
| Partial payout; payout reversal | `recordCommissionPayout`, `reverseCommissionPayout` | integration: "pays in part…"; "reverses a payout…" |
| Sale return and refund adjustments, traceable | negative accrual rows flow into runs as net lines; a member whose returns outweigh sales is held back | integration: calculate test (`giveBack` nets the sale) |
| Carry-forward of unpaid approved commission | `closeCommissionRun`, `commission_settlement_carries`, `carry_forward` lines | integration: "closing a part-paid run carries…" |
| Payroll-settled accruals: no double payment | shared claim column, CHECK, guarded claim paths | integration: the two "database keeps payroll and settlement…" tests |
| Standalone settlement: a payout document on the same 2300 liability | payouts post Dr 2300 / Cr cash or bank | integration: "pays in part…" (journal lines asserted) |
| Permissions split: view, calculate, approve, payout, reverse | four keys, presets, route map | `permission-matrix.test.ts`; `growth-access.test.ts`; route tests |
| UI: run list, run detail, source-sale drill-down, warnings, approval summary, payout status, statement, journal links, filters, export | `growth/commission-runs-section.tsx`, `growth/commission-run-detail.tsx`, the `runs` pages | type check, lint, design checks, route tests; no browser test (see Gaps) |
| Reconciliation: accrued liability reconciles to the unpaid position; no double payment; reversal reconciles; payroll and standalone exclusive | `GET /api/commission/liability` and its card; payroll tie-out extended | integration: tie-out asserted after each step |
| Sync: a payout and a reversal reach the outbox, and only the cloud records them | migration 0217 (`scope`, `business_id`, business branch of `tenant_isolation`); `appendBusinessSyncOutboxEvent`; registry, handler, catalogues; pull, push, health and status queries name `scope` | `integration/commission-sync-events.integration.test.ts` (11 tests: same transaction and rollback, retry, doubly delivered append, a desktop's pull through `runServerPull` acknowledges it under its own location, desktop applies once, replay refused, branch pull excludes, business-wide feed, tenant isolation, site refuses); `sync-events.integration.test.ts` and the sync regression files |
| DoD 1: accruals grouped into immutable settlement runs | line and run guards in migration 0216 | integration: calculate test |
| DoD 2: approval and payout are separate audited actions | separate endpoints; each action writes an `audit_log` row | integration: "refuses the calculator's own approval…" asserts the audit trail of the run and of each payout |
| DoD 3: partial and full payout are idempotent | `Idempotency-Key` plus request fingerprint; unique index on `(business_id, idempotency_key)` | integration: "pays in part…" (partial, replay, conflicting key, then the full payout) |
| DoD 4: no accrual settled twice | claim column, CHECK `commission_accruals_one_claim`, row locks, count checks | integration: the two database-claim tests |
| DoD 5: returns and reversals create traceable adjustments | negative accrual rows; mirror entries; reversal documents | integration: calculate test (return); "reverses a payout…" (mirror, once, trail) |
| DoD 6: payroll and standalone payout cannot double-settle | CHECK plus both claim paths | integration: the database-claim tests |
| DoD 7: commission liability reconciles to the GL | two identities, both zero in the tests | integration: tie-out asserted after each step |

## Deviations and gaps, stated plainly

- **Sync events are business-scope, not location-scoped.** `CLAUDE.md` asks for a registered
  `appendSyncOutboxEvent` for each money-moving action. A payout covers every branch, so it has no
  location, and the outbox had none to give it. You asked for explicit business scope, without a
  borrowed location. The cloud records each payout and reversal in the transaction that moves the
  money, and a desktop acknowledges a pulled copy without applying it. The design and its
  consumers are in `docs/server-sync.md` (*Business-scope events*). Location-scoped sync is unchanged.
- **Payroll-settled rows are not run lines.** A run excludes rows that payroll already holds and counts
  them in a warning. The member statement shows the settling run or payroll period for each row. The
  issue's «link run lines to the payroll settlement» is met at the statement, not on the line.
- **Unmapped sellers are warned, not accrued.** A sale whose seller has no commission rule in force never
  writes an accrual. The run reads the current sales (by `orders.opened_by`) and the current rules, and
  warns (`unmapped_seller`) with each seller's line count and sales value (before invoice discounts). The
  warning does not cover a rule-scoped line for a seller who does have a rule.
- **Payroll provenance is a count and a period, with a link to the payroll screen.** A run that excludes
  rows already held by payroll says how many rows, per payroll period (`claimed_by_payroll`). The link
  goes to `/accounting/payroll`; it does not open the payroll run itself.
- **No project filter.** Commission has no project dimension in this codebase.
- **Category-scoped rules never match.** The retail invoice path does not pass a category
  (`retail-invoice-service.ts`). This predates #869 and is unchanged.
- **Screens have no browser test.** The type check, lint, the design checks and the route tests cover
  them. The visual-regression baselines do not include the commission screens, and no Chromium was
  available here, so no screenshot was taken.
- **The optional row-click fix was not needed.** `DataTableRow` already ignores clicks whose target is
  inside a link, so the run-number link in the runs table does not navigate twice. A regression test
  now covers that (`src/app/dashboard/data-table.test.tsx`).

## Decisions to confirm

- **Self-approval is refused for everyone**, owner included: the person who calculated a run cannot
  approve it (`mayApproveRun`, 403 `approver_is_calculator`). You confirmed this. An owner exemption
  would be a one-line change.
- **The manager preset gets calculate only.** Approval and payment are the accountant's work, so the
  accountant holds all four keys. Change the presets in `permissions.ts` if you want the manager to
  approve.
- **Closing a run carries balances forward; it does not write them off.**
- **A reversal is the only correction after payment.** A closed run is final.
- **Three ledger labels were added** (`commission_payout`, `commission_payout_reversal`, and
  `carry_forward`, the source code a carried line stores). `ledger-source-labels.test.ts` requires a
  Persian label for every stored source code, and the first full unit run failed on these three.

## Gates

Final state of the branch at the head that carries this section (Node v22.22.3 here, v24 in CI;
Postgres 16 from `embedded-postgres` on 127.0.0.1:55432; `NODE_OPTIONS=--max-old-space-size=3072`).
The branch was merged with `origin/main` at `55a9b7ee` before these runs.

| Gate | Command | Result | Exit |
| --- | --- | --- | --- |
| Migrations | `npm run db:migrate` | up to date | 0 |
| Type check | `npx tsc --noEmit` | clean | 0 |
| Lint | `npm run lint` (`eslint . --max-warnings=0`) | clean | 0 |
| Unit | `npx vitest run` (`npm test`) | 725 files, 9483 tests passing | 0 |
| Database (full) | `npm run test:db` | 204 files, 2855 tests passing, 1 skipped (`ai-gateway`, pre-existing guard) | 0 |
| Commission database | `integration/commission-settlement.integration.test.ts` | 17 of 17 (includes the statement-total regression) | 0 |
| Design | `npm run test:design` | 5 files, 38 tests passing | 0 |
| Production build | `npm run build` | compiled; commission routes listed | 0 |
| Visual regression | `npm run test:visual` against the production build | 14 of 14 screens match their baselines | 0 |
| Live browser smoke | `scripts/` smoke run against the production server (see below) | 8 of 8 checks | 0 |

Notes:

- `npm run format` does not exist in this repository, so no format gate was run.
- The `accounting-expenses` baseline that failed in CI at `6884033` (3.67%–4.06%) matches the render at
  this head. The merged `main` (PR #881, commit `a4e8aa86`) re-recorded `accounting-expenses.png` and
  `accounting-receivables.png`; this branch carries that baseline. No baseline was re-recorded here.
- The database suite ran before the final design-lint fix, which only touched a loading placeholder in
  `commission-run-detail.tsx`. The design suite and the unit suite were re-run after that fix.
- Not run: `npm run test:e2e:media`, and the CI jobs on the pushed head (see the push report).
