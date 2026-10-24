# Issue #869 — Commission run approval, settlement and payout lifecycle — implementation plan

> Release follow-up (2026-10-16): PR #964 is merged. Newer test, shippables and
> Windows 1.0.59 evidence supersedes the cancelled original post-merge runs, but
> Coolify deployment remains unverified. See [release verification and operator
> handoff](../audits/commission-release-verification.md) for exact SHAs, failures,
> supersession, workflow safety fixes and remaining blockers. Keep #869 OPEN.
> The implementation checkpoints below are historical, not current release status.

Historical completion branch: `arena/f54736c8-biza-miz`, audited against `main`
`916df457eca2fef2123b3cfb6507bd0cfeacfe3e` on 2026-10-15. The original lifecycle
was merged in PR #930 (`b4b7d22ba9886f589c3af8bff370984ca0f4bdb5`, 2026-10-12).
The completion audit below supersedes the historical implementation/gate notes.
Latest `main` `fe486e4e827983efa4062cb83e50272a7eb1a267` was re-audited on the same
date: automotive/AI/release additions leave commission finances and business-scope
commission contracts unchanged; PR checks use the current merge ref.

Before merge, `main` advanced again to `ef2c98e0e770a05352603ab384fa184c8648d248`
(financial accounts/internal transfers #965 and MCP OAuth #960). Integrated that
target on the same completion branch rather than relying on the older green merge
ref. The expanded exact-journal writer preserves base-Rial defaults and zero foreign
legs for commission/payroll callers; existing commission formulas and v1 sync
contracts are unchanged. Both new Accounting work areas and exact payroll-source
navigation are preserved. The integrated candidate must earn fresh local/CI gates;
prior green results below remain explicitly versioned evidence, not a new-head pass.
Local integrated-tree checks at `891fd5d`: full typecheck and lint PASS; all three new upstream
migrations apply successfully; financial PostgreSQL **339 tests / 8 files PASS**
(commission, both payroll suites, and the new financial transfers). Fresh full unit,
full PostgreSQL and current-head CI are required before merge; live results remain
in PR #964 to avoid treating an older green target as verification of this merge.

Integration audit found a genuine currency-source gap in the existing shared
payroll/commission resolver: both explicit foreign-bank selection and the legacy
bank fallback posted a Rial-only document without FX. Two deterministic PostgreSQL
regressions failed before the fix (both calls incorrectly succeeded). The shared
selector now excludes explicitly foreign accounts and the resolver rechecks the
chosen account's currency under `FOR SHARE` through commit. Legacy/IRR accounts,
legacy method/heading behavior, approval policy, formulas and v1 sync are unchanged;
no FX engine was built. Pure eligibility/currency-race tests and commission/payroll
atomic refusal tests cover the fix. The pre-fix `339/8` result is not a pass for
this new code; full local/CI gates must be rerun before release.
After the guard: full typecheck/lint PASS; focused financial PostgreSQL **343 / 8
files PASS**, including both explicit/fallback foreign-bank refusals and all legacy
Rial payment regressions. Pure selector/recheck tests PASS (8 / 2 files). Fresh full
unit/full PostgreSQL and CI are running; their final verdict belongs in PR #964.

Scope from the issue: complete the commission financial lifecycle *after accrual*.
Commission rules, seller assignment, effective dates, accrual posting and the rules-and-report
screen (#764) are not rebuilt. Payroll's own commission settlement and the 2300 tie-out (#835,
migration 0215) are extended, not replaced. #869 owns run → approval → settlement → payout.


## Completion audit — 2026-10-15

Evidence read: live issue #869 body and comments (seven unchecked original DoD items;
no comments), merged PR #930 body/comments, current `main`, settlement/lifecycle/planner/
payout code, payroll, commission APIs and Growth screens, migrations 0216–0218,
commission/contention/RLS/sync tests, `docs/features/commission-settlement.md`, payroll and
business-scope sync documentation. No replacement financial subsystem or balance table.

| Requirement | Audit status / completion evidence |
| --- | --- |
| Immutable runs and rule/employee/source snapshots | Complete in #930; existing line guards retained. Rule terms are the terms at calculation, not a reconstructed historical rules database. |
| Separate approval/payout and audit trail | Complete in #930; calculator cannot approve, including owner; policy unchanged. Review and approval share `commission.approve`. |
| Partial/full payouts, retries, reversals | Complete in #930; locked run, allocation bounds, request fingerprint, unique keys, mirror journals; concurrency and rollback tests retained. |
| No duplicate accrual settlement | Complete in #930; same payroll advisory lock, row locks, mutually exclusive claim CHECK and affected-row checks. |
| Returns, corrections, close/carry | Complete in #930; signed accruals, append-only reversal, posted-history guards and employee-level carries retained. |
| Consistent GL reconciliation | Defect fixed here: both commission and payroll tie-outs now read via existing `inSnapshot` / explicit client runner. Includes open standalone runs AND unclaimed carries on that same connection. No RLS bypass, mutation lock, rounding or zero-forcing. |
| Statements | Previously correct lifetime sums but capped history. Added independent accrual/payout paging, date/run filters, full filtered CSV (20,000 rows per history; explicit refusal above cap), sale/journal/run IDs and navigation. All totals remain lifetime DB sums, even for empty filters. Statement reads also use one snapshot. Payroll provenance now uses a supported exact `?run=<id>` source panel with the existing permission/RLS API, independent of history paging. |
| Warnings | Fixed sale-day effective windows, item/brand scope, missing/inactive assignments without accrual, and inaccurate claim wording (payroll-held is not necessarily paid). Never accrue money from a warning. Historical lines with existing accruals are not re-diagnosed from subsequently edited rules. |
| Rule-engine/category scope | Pre-existing #764 dependency, not rebuilt: retail producer does not pass category; a category rule no longer hides the warning. Rule edit history is not available to reconstruct past active flags. Warning sales values remain pre-discount, explicitly documented. |
| Financial permissions / tenant isolation | Existing five permissions, service transitions, API guards and FORCE RLS retained. Added snapshot reporting probes under a non-superuser/non-BYPASSRLS app role. |
| Browser acceptance | In-repo real-app multi-user script added (`npm run test:e2e:commission`) and wired into the existing production/RLS browser CI job. Full expanded Rial/Toman real-production acceptance passed at `9fdb199`, including both themes, three widths, WCAG, keyboard/focus, filter races/offline recovery, exact source navigation and refusal/correction lifecycle. See the versioned evidence below. |
| Synchronization | Existing transactionally appended business-scope recorded/reversed v1 contracts preserved. Existing PostgreSQL tests exercise outbox rollback, duplicate delivery, site refusal, replay and scope. Controlled real central/site HTTP acceptance PASSED at `9fdb199` on separate DBs/processes under the non-BYPASSRLS app role. Customer deployment/physical-device pairing/full IAM scheduler are not claimed. Branch-bound devices intentionally do not receive business-scope events; a business-wide feed does. |
| Cleanup | Cross-reference audit of settlement helpers/API/UI/tests/sync consumers; no confirmed dead financial path removed. The optional non-snapshot runner default on standalone outstanding was removed: its sole consumer must supply the report runner. |
| Release / closure | BLOCKED until all mandatory gates, live two-instance verification and merge. Keep issue #869 OPEN. No automatic-closing PR keyword while blocked. |

### Regression evidence added

- PostgreSQL table-lock barriers in `commission-contention.integration.test.ts`: report
  reads GL, blocks on accrual history, real payout/reversal/payroll transaction commits,
  report finishes with exactly the pre-commit position; a fresh report sees the new state.
  Both reports, and statement totals/history, are exercised. A genuine manual GL discrepancy
  beyond 2^53 remains visible to the last Rial.
- Whole-history statement fixture: walk 522 signed accruals and 603 payout/reversal
  allocations without omission/duplication; totals unchanged on every page or empty date
  filter; CSV mode ignores page offsets and returns the full filtered history.
- Sale-day rule warning regression, nonmatching item/brand/category scope, missing seller.
- Signed CSV correction: existing run-line exports threw on negative return amounts because
  they called a nonnegative input formatter. Shared exact signed export formatting now
  preserves negative amounts, values beyond 2^53 and the final Rial digit in Toman files.
- Strict statement query and HTTP view/export permission contracts.
- Real browser exposed native label activation around multi-control Jalali pickers:
  Today updated the date then reopened the calendar over Submit. Commission date fields
  now use `Field as="div"` with explicit picker names; the E2E asserts the picker closes,
  without force clicks or relaxed timeouts.

### Verification record — verified application head `9fdb199`

Evidence as of 2026-10-15. Later candidate results and the live release checklist
are maintained in [PR #964](https://github.com/hamidnoshady/biza-miz/pull/964), not
inferred from this historical gate snapshot. Earlier tables below describe #930 only.

| Gate | Verified result / current continuation |
| --- | --- |
| TypeScript / ESLint | Full continuation typecheck and lint PASS locally and Actions at `9fdb199`. No assertion, timeout, visual baseline or security threshold was weakened. |
| Full unit | 11,429 tests / 867 files PASS locally at `9fdb199`; full unit PASS in Actions. Existing payroll UI and new source/statement/capability/API tests are included, not added again to that total. |
| Financial PostgreSQL | 247 / 6 files passed locally: payroll 184, accrual 11, settlement 23, contention 10, sync handlers 12, RLS 7. |
| Full PostgreSQL | Actions PASS at `03f9cb3`, run `38728481214`, 31m18s. The previous local run's final log is unavailable after workspace rehydration; it is not counted as a pass. A fresh full local run is in progress; no final verdict yet. |
| Actual-app browser | Original multi-user commission lifecycle PASS on the production/non-BYPASSRLS runtime at `03f9cb3`, job `116401557439`. Full expanded Rial and Toman PASS at `9fdb199`, production/RLS job `116451226863`, run `38743483853`: both themes, three widths, WCAG, keyboard/focus, delayed real upstream response, offline/retry, exact payroll source, overpay/reject/recalculate/void and final zero tie-out. An initial error-state test-locator defect was fixed without changing UI financial assertions. |
| Production build | Actions PASS at `9fdb199` (4m34s in the push workflow). Local cold builds exceeded the 3.8 GiB sandbox; no local pass or threshold change claimed. |
| Pinned visual / packaging | Actions pinned visuals PASS (5m54s), packaged Windows E2E PASS (16m42s), desktop shell and production container PASS at `03f9cb3`. At `9fdb199`: pinned visuals PASS (5m27s), desktop shell PASS (7m2s), production container PASS (10m22s); fresh Windows packaging still running at this evidence snapshot. No baseline regeneration. |
| Controlled central/site HTTP | PASS at `9fdb199`, job `116451226863`, transport step 36s. Real scope/authority/failure/backoff/recovery/duplicate checks and unchanged site financial counts; non-secret artifact `11976762680`. This is not customer deployment/physical pairing/IAM-scheduler evidence. |
| Actions / merge | At `9fdb199`, all completed checks PASS; full PostgreSQL and Windows still running. Full required aggregate must pass on the eventual final documentation head too. PR #964 remains draft; #869 OPEN; no merge or closure at this evidence snapshot. Follow the live PR checklist for later gate/merge results. |

### Continuation delivered after `03f9cb3`

- Added supported `/accounting/payroll?run=<id>` source navigation through existing
  Accounting gates and the `payroll.view` API. Exact immutable lines open read-only,
  including outside history paging; foreign/missing/error/retry and stale-owner states
  are explicit. No alternate payroll settlement engine or mutation surface.
- Fixed statement filter options disappearing during requests. Only run labels persist;
  old totals/history remain hidden until the current URL's answer is ready.
- Closed omitted `/api/commission` → `app.growth` capability mapping. A Hybrid site
  must not become a second HTTP payout authority. Existing permissions, self-approval
  policy, rule engine and financial formulas are unchanged; broader #764 audit stays there.
- Extended real-app acceptance for both business units, both themes, three widths,
  focused WCAG/contrast, keyboard/focus, delayed actual upstream response and actual
  offline/retry. Added a real payroll claim fixture, overpay denial and reject/recalculate/void.
- Added controlled central/site processes and separate DB snapshot bootstrap with RLS
  application roles. The real production pull client checks v1 recorded/reversed envelopes,
  credential scope, site refusal, actual transport failure, production backoff, recovery,
  recovery re-read, durable cloud-owned effects and no duplicate site payments/journals.
  Branch-bound devices intentionally exclude these business-scope events. This does not
  claim a physical modern-device pairing ceremony or full IAM-gated automatic scheduling.
  Successful transport runs retain whitelisted event/payout/reversal/journal/effect IDs,
  exact Rial amounts, retry/cursor state and before/after financial counts in the
  `commission-transport-evidence` artifact, never fixture credentials or passwords.

Verified real transport client-event IDs (no tokens):
`ee6e0092-8ecd-5283-8468-17bf7ff0147b`, `e9e4acb8-d1c7-5e29-9712-eb152f60dd86`,
`d9498b19-fc2a-5104-bd4c-4934b8178d30`. The
[retained evidence](https://github.com/hamidnoshady/biza-miz/actions/runs/38743483853/artifacts/11976762680)
links source payout/reversal/journal IDs to durable site effects and exact cursor/retry state.

Remaining release work at this snapshot: finish full local PostgreSQL and all fresh
required checks/Windows on the eventual final documentation head, then merge only if
the mandatory criteria pass. The #764 category-producer and historical-rule limitations
remain explicit, not silently rebuilt or bypassed. A #764 coordination comment was
permission-denied (GitHub integration 403); the scope is cross-referenced in PR #964.
Keep #869 OPEN until mandatory criteria and merge are complete. Physical pairing,
customer deployment and the full IAM-gated scheduler are not inferred from this
business-wide production-pull acceptance.

---

## Historical implementation record (PR #930)

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

- [x] `docs/features/commission-settlement.md`: the lifecycle, what a run contains, paying and reversing, the
      reconciliation identities, the permissions, the API, and the decisions and gaps below.
- [x] This plan. The payroll tie-out comments are updated to the new meaning of «unsettled».
- [x] Gates run on the final state; results in the Gates section below.

---

# Status

Historical delivery from `arena/40246fe8-biza-miz` was merged through PR #930. The table maps each requirement of the
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
  consumers are in `docs/architecture/server-sync.md` (*Business-scope events*). Location-scoped sync is unchanged.
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
