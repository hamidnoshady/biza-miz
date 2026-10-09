# Receivables audit (#825) — implementation and verification

PR: #881, branch `arena/f1cf4030-biza-miz`. No merge or deployment is authorized.

## Review baseline

- Reviewed GitHub head: `147b7a370a73279353e1a805a4728990f46a8f49`.
- Main inspected at start: `7b1b11c54f9ccb19a82fba69b590d10b10da31ba`.
- PR was open and mergeable. Exact-head run **37920439051** passed typecheck,
  lint, units, real-DB integration, API guards, data transfer/tenancy, design,
  production build and media E2E. Visual regression failed: receivables **0.98%**,
  expenses **4.06%**. Desktop and shippable workflows passed on that head.
- Local baseline: focused subledger suites **24/24** and TypeScript passed.
  This is not a claim of a complete local pre-change baseline.

## Corrections after review

1. Replacement requests own a generation from the moment the search changes,
   including debounce. Paging requires that generation's successfully loaded
   first page. Only the page owner can finish its loading state. Invalidation
   releases old state; old callbacks cannot unlock or overwrite newer work.
   Replacement errors preserve readable rows but do not page against stale rows.
2. Each balance query counts its filtered CTE independently of its page, in one
   SQL snapshot. A LEFT JOIN preserves the count on empty windows; a `present`
   marker distinguishes the metadata-only row from the legitimate null-ID bucket.
3. Both APIs share strict integer window validation. There is **no offset clamp**.
   Invalid/unsafe offsets and limits outside 1–200 return 400 `invalid_pagination`.
   Responses supply `nextOffset`; clients advance by consumed server rows, not
   deduplicated DOM rows. Empty/end pages terminate. Ordering remains deterministic.
   Offset pages describe a live ledger, not a frozen accounting snapshot: writes
   between pages can move rows. Refresh to obtain the latest order/summary.
4. Named statements now start from the canonical source relation with the party
   predicate pushed into its source arms. Balances/aging use the same relation as
   a LEFT JOIN, retaining missing and intentionally unattributed sources. No
   shadow table, journal rewrite, or second attribution implementation was added.
5. The shared overlay's existing Escape hook was imported but not called. It is
   now called with the existing busy guard; a payment cannot dismiss mid-submit.

## Ownership / compatibility audit

- Shared `SubledgerSection` and its statement panel remain the sole A/R/A/P UI.
- `ApStatementPanel` is a live compatibility adapter used by the party directory,
  **not** dead code. Retained; no framework route or dynamic import was deleted.
- Directory, cheque, expense and receipts/payment pickers use `scope=directory`;
  the party-directory balance column and AI/service consumers still require the
  unbounded legacy response. Requests without search/paging retain that behavior.
- The two paginated UI configurations now read `nextOffset`; all direct paginated
  callers found by repository search are integration tests and were updated.
- Canonical source relations own attribution and source metadata. A/R's exported
  fragment and ID expression remain re-exported from `ar-service` for CRM and
  other existing consumers. A/P retains its public source contract/status labels.
- Removed the duplicated route parsing/clamps and unused A/P statement as-of
  filtering branch (aging has its own SQL read). No external API endpoint removed.

## Query-plan evidence

Reproduce with real PostgreSQL (the suite creates/drops a scratch database):

```sh
DATABASE_URL=postgres://pos:pos@127.0.0.1:5432/pos \
SUBLEDGER_PLAN_OUTPUT=/tmp/subledger-plans.json \
NODE_OPTIONS=--max-old-space-size=3072 \
npx vitest run --config vitest.db.config.ts integration/receivables-hardening.integration.test.ts
```

Fixture: 50,004 multi-role parties and supplier aliases, 50,004 receipts and
payments each, 100,010 journal entries, 200,020 journal lines, plus another
business's entries. This is a synthetic large-list/source-access stress fixture,
not a production trace; the smaller A/R/A/P/cheque/F11 suites cover the broader
source mix, returns, amendments, installments, future dates and overpayments.
`ANALYZE` runs before measurement. EXPLAIN uses **ANALYZE, BUFFERS, FORMAT JSON**
under a temporary **NOSUPERUSER NOBYPASSRLS** role and business GUC. The test also
tries a wrong-tenant predicate under this role and expects no rows.

Before the source access correction, A/R and A/P statements each scanned **50,005
control-account lines** and the tenant's journal history to return one line.
Filtering the result was not efficient access. Measured times: ~442 ms / ~583 ms.
After the correction and the final migration 0216 journal source index, a fresh
isolated rerun measured ~0.25 ms / ~0.56 ms, using
`idx_journal_entries_business_source` and `idx_journal_lines_account_entry`.
The regression test bounds **actual journal tuples visited**, including removed
rows and loops, for both statements; it does not assert machine-specific latency.

Balances and aging necessarily aggregate the tenant's control-account history.
On this deliberately large all-advance fixture, measured broad reads were roughly
0.7–1.2 s under RLS; they return a bounded balance window or one aging row per
party, not journal history. Date predicates remain in SQL. Existing account/entry,
business/date, party-source and source-primary-key indexes were reviewed. The
existing journal source unique index is partial on **non-null posting_kind**, so
ordinary receipts/payments cannot use it. Migration `0216_subledger_statement_access.sql`
adds the measured missing business/source lookup. No new table requires a policy;
existing journal RLS remains enforced. Unknown statements must inspect unmatched
sources across the account and are not claimed to be single-party index lookups.

## Acceptance evidence map

| Issue criterion | Source | Verification |
|---|---|---|
| Permission-derived actions, authoritative writes | accounting-manager → ar/ap-section → subledger-section; receipts/payments routes | subledger-capability, component permission tests, receivables-hardening/API guard suites |
| Active, unmerged customer role in same business | ar-service.receivePayment | ar.integration + receivables-hardening: supplier/employee-only, inactive, merged, valid/multi-role, cross-business |
| Real calendar dates and business-local defaults | iso-date, ar/ap services and aging routes; businessToday | iso-date units; ar/ap + hardening impossible/leap date tests; business-day suites |
| SQL aggregation, bounded statement access, as-of aging, indexes | ar-attribution, ap-attribution, ar/ap-service, migration 0216 | real source/aging tests; RLS EXPLAIN work assertions; subledger-sql-shape |
| Search/pagination/stable order/unknown | subledger-pagination; ar/ap balance CTEs and routes | 50,004-party real API test: >50k continuation, empty out-of-range count, search, repeat ordering, unknown and tenant exclusion |
| Backend reconciliation, invariant totals | getAr/ApReconciliationSummary; BalanceSummary | ar/ap totals/reconciliation tests; API summaries unchanged across empty/search/pages |
| Source metadata and drill-down | canonical source relations; statement panel; entries/[id] route | AR/AP/cheque/amendment tests; desktop/mobile in-place journal tests; tenant-protected entry API |
| Empty/error/retry/stale/append states | shared subledger request ownership | deferred UI tests controlling old/new completion; paging/refresh failure tests; loading preserves rows |
| One party model/shared UI/no shadow balances | same services and shared component | architecture guards; canonical source-fragment tests; no balance-table migration |
| Money/Jalali/a11y | useMoney, fmtJalali, JalaliDatePicker, OverlayDialog | Rial/Toman and both-layout date component tests; Escape/busy guard tests; design checks; browser review recorded below |

## Visual review and final verification

Results and limitations are recorded below after execution. Baseline approval,
local execution, exact-head CI and deployment verification are distinct gates.
No deployed verification has been performed.

### Browser / visual evidence (not baseline approval)

- Seeded app-role browser checks in Chromium 141 passed on receivables at
  **1440×900 and 390×900, light and dark**: RTL, selected Toman display, no
  page-level horizontal overflow, populated statements and Escape dismissal.
  Component tests separately exercise selected Rial/Toman and Jalali dates in
  both rendered layouts. Screenshots were inspected; this is development-mode
  browser evidence, not production pixel approval or an exhaustive screen-reader audit.
- Inspected the committed receivables and expenses baselines, locally captured
  actuals, and locally generated diffs using the unchanged comparison function.
  The receivables change is the intended authoritative KPI strip/search/window
  count. Expense history traces the form layout/settlement additions to inherited
  `db710571` (#879), not this pagination patch; its three seeded rows and register
  totals remain visible locally. Main also has a later expense redesign (#832),
  not part of the reviewed head. No unrelated expense feature was reverted.
- **The exact CI actual/diff images have NOT been inspected.** Artifact
  `11611904337` (`visual-diffs`, run 37920439051) exists, but downloading it
  redirects to an Azure Blob host blocked by this sandbox's allowlist. Local dev
  images also include dev chrome and, on expenses, a transient connection banner.
  Their differences are not interchangeable with CI's 0.98% / 4.06%. In particular,
  the full 4.06% expense failure cannot safely be classified from these images.
- No baseline PNG, tolerance, visual assertion, workflow gate or production UI
  was changed to conceal these failures. Both production visual failures remain
  open pending exact artifact inspection and the repository's reviewed, targeted
  approval process. No blanket recording was performed.

### Local checks

- TypeScript: passed with the repository's 3 GB heap setting.
- ESLint: passed, zero warnings. Formatting: `git diff --check` passed; the
  repository does not define a separate formatting script.
- Full unit suite: **690 files / 8,714 tests passed**.
- Focused real PostgreSQL suites during implementation: **104 tests passed**
  (A/R, A/P, route hardening/large-list plans, cheques).
- Full real-DB invocation: **196/197 files passed, 2,548 tests passed, 14 skipped**;
  exit 1. `aec-commercial` hit its existing 120-second setup timeout and a
  connection-terminated exception during the concurrent dev-server memory failure.
  With the dev server stopped, its unchanged isolated rerun passed **13/13** in
  63.17 seconds. The remaining skip is the existing optional AI-gateway test.
  Thus all 197 files have passing local executions, but the single full invocation
  was not green; no timeout or assertion was weakened.
- Final fresh-schema hardening/EXPLAIN rerun: **16/16 passed**, using only the
  final migration 0216 index. Named A/R and A/P plans each visited one journal
  line (entry scan work 2 and 1 respectively), returning one statement row.
  Balance/summary/aging timings in ms: AR 651/804/937; AP 916/972/1136.
- Design checks: **5 files / 38 tests passed**.
- Production build attempted with Node 24: a 2,300 MB heap attempt was killed
  (exit 137); a narrowed 1,792 MB, single-threaded attempt hit V8 heap OOM
  (exit 134). This is an unpassed local gate, not a successful build claim.
- `npm run test:visual` was attempted against dev after those build failures; it
  timed out compiling the first route. Narrower seeded browser reviews above
  succeeded once compiled. They do not replace the full production visual gate.

Final full-DB, design and exact-head CI outcomes are recorded in the PR verification
comment and final delivery report, rather than treating a prior head's CI as current.
