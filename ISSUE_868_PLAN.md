# Issue #868 — Accounting Dimensions: cost centres, profit centres and detail analytics — implementation plan

Working branch: `arena/10b8596c-biza-miz` (from `main` at `7b1b11c`)

Baseline: the checks run on `7b1b11c` before the first change were logged under `/tmp`, which a sandbox restart cleared, so they are not cited here. The evidence of record is the final run in §Verification below, on the branch.

- The issue body was read from the API (`gh api repos/hamidnoshady/biza-miz/issues/868`), not from a summary. The `gh issue view` command fails on this repository's Projects (classic) deprecation, so the API is the route.

## §1 The model, and why it is line-level

**Decision.** A dimension is an attribute of a **journal line**. `journal_lines` carries four nullable columns — `cost_center_id`, `profit_center_id`, `department_id`, `detail_dimension_id` — each a foreign key to one table of dimension values, `accounting_dimension_values`. `journal_entry_draft_lines` and `expenses` carry the same four columns: a draft line is the line before it is posted, and an expense is the document whose debit line carries its cost.

**Why line and not entry.** A single document can rightly split one expense across two cost centres, or one sale across two profit centres. An entry-level dimension cannot say that; a line-level one can, and an entry-level value is just the special case where every line agrees.

**Project and branch are not dimensions.** They already live on the entry header: `journal_entries.project_id` (migration 0143) and `journal_entries.location_id`. They stay there and are never copied into a line. Consequences:

- A project is never duplicated as a cost centre. The screens say «پروژه» for the project and «مرکز هزینه» for the cost centre, and the journal's old filter that read «پروژه / مرکز هزینه» was relabelled.
- A branch is never duplicated as a profit centre. A profit centre is a line of business that can cut across branches; the branch P&L already exists and is untouched.
- The reports that need both read the header and the line.

**Four kinds, and only these four.** `cost_center`, `profit_center`, `department`, and `detail`. The detail kind is the issue's «optional configurable accounting detail dimension»: one slot whose name the business chooses (`accounting_dimension_settings.label`, default «بعد تحلیلی»). Each kind is off until a business switches it on. A business that never does posts exactly as it did before, with no extra field on any form.

**Value records.** `accounting_dimension_values`: business scoped; `kind`; `code` (unique per business and kind, ignoring case and surrounding spaces, and including archived rows, so a retired code is never reused); `name`; optional `parent_id` (same kind, same business, no loops — enforced by a composite foreign key and a trigger); optional `location_id` (a branch restriction); optional `effective_from` / `effective_to`; `is_active`.

**Hierarchy is organisation, not rollup.** A value with children is a parent, and a parent is never a posting target (the same rule the chart of accounts applies). The reports group by leaf values and do not add parents up. A rollup view is a deferred item (§7).

## §2 The posting policy, and where it is enforced

Two layers, split on purpose.

**The database** enforces what no decision could make true, whatever a caller does (migration `0216_accounting_dimensions.sql`):

- a line's value belongs to the same business as its entry (`accounting_dimension_check_all`, a `BEFORE` trigger on `journal_lines`, `journal_entry_draft_lines` and `expenses`);
- a value sits in the column of its own kind (the same trigger);
- a parent is of the same kind and business (a composite foreign key);
- a parent loop is refused (a recursive check, `accounting_dimension_no_cycle`);
- a value that postings reference cannot be hard-deleted (a foreign key with no `ON DELETE` action, so a business-level cascade still works);
- every new table has row-level security enabled and forced, with the same `tenant_isolation` policy as the rest of the ledger.

**The service** decides the policy questions, which change over time: is the kind enabled, is the value active, is it a leaf, does its branch match the entry, is the entry's day inside its effective window. One pure function, `dimensionPostingFailure` in `src/lib/accounting-dimensions.ts`, makes that decision, and it is called from one place, `assertDimensionsPostable`, which every writer reaches through `insertJournalLines` (`ledger-service.ts`), the draft writer (`manual-journal-service.ts`) and the expense writer (`expense-service.ts` → `postJournalEntry`). A path cannot be stricter or looser than another because they do not decide separately.

The policy runs **only when attribution is present**. A posting without dimensions runs no dimension query at all, which is every posting that predates this feature.

Refusals carry a stable code (`dimension_kind_disabled`, `dimension_inactive`, `dimension_not_leaf`, `dimension_branch_mismatch`, `dimension_not_effective`, …), translated once in `DIMENSION_ERROR_MESSAGES`, and the screens and routes return the same code.

**The check is repeated at approval.** A value can be archived between the moment a drafter chooses it and the moment a reviewer approves the document. Approval runs the policy again, and a refused approval leaves the draft pending and writes nothing (covered by an integration test).

## §3 Reversals mirror; they do not decide

A reversal undoes a fact that already happened. It must succeed even when the value it names has since been archived, the kind has been switched off, or the effective window has closed. So:

- a reversal copies each original line's attribution, column for column (`reverseEntryInTransaction` for manual entries; `mirroredLines` for expenses);
- it calls the posting with `dimensionMirror: true`, which skips the policy and keeps the database's structural guard;
- a reversed expense's reversal row carries the original's attribution too, so the expense register nets to zero by dimension.

Covered by integration tests: a reversal after archive, and a reversal of an expense after archive.

## §4 Permissions

- **Reading** the catalogue and the reports: `ledger.view`, the same door as the journal and the trial balance.
- **Managing** kinds and values: `accounts.edit`. A dimension is part of the structure of the chart's reporting, and the people who may restructure the chart are the people who may restructure this. No new permission key was added, so the permission registry and the role presets are untouched.
- **Posting with attribution** needs nothing beyond the posting itself: `ledger.propose` for a draft, `ledger.approve` for approval, `finance.expenses_manage` for an expense. Attribution is part of the document, not a separate authority.

## §5 Reports

Every report reads **one kind at a time**, or filters by several kinds with AND on the same line. Two groupings of different kinds are never added together, since a line that carries both would be counted twice. Every report that sums columns also checks them against the unfiltered ledger for the same period and reports `reconciled`; a report that does not reconcile says so in red (`dimension-report-table.ts`, `accounting-dimension-reports.ts`).

| Report | Where | What it is |
| --- | --- | --- |
| Account × dimension matrix | `GET /api/ledger/dimension-reports?view=matrix` | every account against every value of one kind, plus a «بدون بُعد» column; optional account type (for example expenses by cost centre). A non-zero cell links to the journal lines behind it |
| Profit by profit centre | `view=profit` | revenue, cost of sales, gross profit, labour, operating expenses and net income per profit centre, classified the way `getProfitAndLoss` classifies them |
| Cost-centre account card | `view=card` | one account's lines for one value (or the unassigned lines), with the opening and closing balance, which the integration suite proves close |
| Trial balance by dimension | `GET /api/ledger/trial-balance?dimension=…&value=…` | every figure restricted to one value; the whole-ledger integrity check is still computed whole-ledger |
| Journal by dimension | `GET /api/ledger/entries?costCenter=…&profitCenter=…&department=…&detail=…` | documents with a line that carries every chosen value |

Export and print: the dimension reports export CSV (`toCsv`, BOM and CRLF, formula-safe) and print through the browser. The trial balance's server-side export does not apply a dimension filter, so the export button is hidden while a dimension filter is active rather than exporting the whole ledger under a filtered screen.

## §6 Phases

### Phase 1 — schema and the pure rules

- [x] `migrations/0216_accounting_dimensions.sql`: settings and values with RLS; the four columns on `journal_lines`, `journal_entry_draft_lines` and `expenses`; the structural triggers; the parent-loop check
- [x] `src/lib/accounting-dimensions.ts`: kinds, labels, the posting policy, the line parser, the import resolver, the report filter, the refusal messages — with `accounting-dimensions.test.ts` (35 tests, integer fixtures)
- [x] `src/lib/accounting-dimension-reports.ts`: the matrix and profit builders, the reconciliation rule, the SQL predicate builder — with `accounting-dimension-reports.test.ts` (16 tests)

### Phase 2 — the service and every posting path that carries attribution

- [x] `src/lib/accounting-dimensions-service.ts`: settings, value CRUD (archive, never delete a used value), `assertDimensionsPostable`
- [x] `ledger-service.ts`: `postExactJournalEntry` and `postJournalEntry` share one line writer; `dimensionMirror` for reversals
- [x] `manual-journal-service.ts`: the draft line carries attribution; the draft is checked when written and again at approval; reversal mirrors
- [x] `expense-service.ts`: the expense row and its debit line carry attribution; the reversal row and its lines mirror it
- [x] `src/app/api/ledger/expenses/route.ts`: `dimensions` parsed strictly; `AccountingDimensionError` answered as 400 with its code
- [x] `src/lib/data-transfer/entities/accounting.ts` and `registry.ts`: the expense sheet carries four optional code columns (`costCenterCode`, `profitCenterCode`, `departmentCode`, `detailCode`, labelled «کد مرکز هزینه» and so on). A code is resolved to this business's own value. An unknown or archived code, or a value the posting guard refuses (kind switched off, branch, date), refuses the row by name. A blank cell posts exactly as before. The export carries the codes only when they are asked for. Covered by seven cases in `integration/expense-import-adapter.integration.test.ts` (21 in that file), and by the registry assertions in `registry.test.ts`
- [x] `integration/accounting-dimensions.integration.test.ts` (30 tests): the database guards, the policy on every path, propagation, reversal after archive, the import resolver

### Phase 3 — reads

- [x] `journal-service.ts` / `journal-filters.ts`: four dimension filters matched on one line; each line returns its labelled attributions
- [x] `ledger-reports-service.ts`: the trial balance takes a dimension filter; `reports-service.ts`: the account statement takes one too
- [x] `accounting-dimension-reports-service.ts`: the matrix and the profit-by-centre reads, each scoped and reconciled
- [x] `integration/accounting-dimension-reports.integration.test.ts` (12 tests): the matrix, the profit groups, the trial balance, the card's closing balance, the journal filter, the AND-on-one-line rule

### Phase 4 — the screens

- [x] `/accounting/dimensions` (`dimensions` in `ACCOUNTING_SECTION_KEYS`; nav, workspace sub-group, heading, icon and manager registered in the same change, asserted by the existing nav and workspace tests)
- [x] Management: the four switches (the detail kind's name is editable), the value list with search and an archived filter, create/edit with parent, branch and Shamsi effective dates, archive, restore, delete (which archives when the value is used)
- [x] Reports: the three views, a kind selector, Shamsi periods, CSV and print
- [x] `dimension-fields.tsx`: one searchable picker per enabled kind; a skeleton while the catalogue loads; nothing for a kind that is off
- [x] Manual entry: a picker per enabled kind on every line
- [x] Expenses: a picker per enabled kind on the form
- [x] Journal: a filter per enabled kind, and each line's attribution shown under its account
- [x] Report drill-down: a non-zero matrix cell in a value column links to the journal lines of that account, that value and the report's period (`matrixCellDrill` and `matrixCellDrillHref`, `dimension-report-table.test.ts`, 11 tests; `dimension-reports-panel.test.tsx` renders the matrix and checks the one link it should draw). The unassigned column and the totals do not link, because the journal cannot filter by the absence of a value
- [x] Trial balance: a kind and value filter; the balance badge and export are withheld while a subset is shown, and a note says why
- [x] The mislabelled project filter («پروژه / مرکز هزینه») is now «پروژه»

### Phase 5 — tests and the documented checklist

- [x] `dimension-catalog.test.ts` (12 tests), `dimension-report-table.test.ts` (11 tests), `dimension-reports-panel.test.tsx` (1 test), `dimension-fields.test.tsx` (5 tests), `dimensions-section.test.tsx` (5 tests)
- [x] Existing suites that the changes touch are green: the journal, the manual entry, the expenses, the trial balance, the nav, the workspace, the route tree, the API guards and the permission sweeps
- [x] `docs/accounting-workspace-ia.md` lists the section in the ledger group

## §7 Deferred, and why

Each of these is a real part of the issue. None is a silent omission: each has its reason here, and the code is written so that the follow-up is an addition, not a rewrite.

1. **Payroll attribution.** Payroll accrues one aggregated entry per run, with no staff-level dimension to read. Attributing salary to a cost centre needs a decision the issue does not make: a per-employee default, or a per-run choice. Until then payroll lines sit in «بدون بُعد», and the report says so.
2. **Fixed-asset attribution.** The depreciation and disposal entries are posted by the asset module. An asset-level default is the natural shape; it touches an ~2,600-line service and was left for its own change.
3. **Purchases, sales and COGS from trading.** These post from order and stock flows that have no cost-centre or profit-centre input today. A profit-centre rule (per product, per channel) is a product decision, and the posting engine can carry the line attribution once that rule exists.
4. **Receipts and payments** are not attributed by design. They settle balances; they do not carry a cost.
5. **Opening and carry-forward entries** that the system generates are not attributed. A manual opening entry *is* attributable through the manual path (§1).
6. **Journal-voucher import.** The expense import is wired (Phase 2): a sheet's code is mapped to this business's value or refused by name, and never created. The Holoo journal-voucher import (`src/lib/integrations/holoo/journal-import-service.ts`, the `Sanad` and `SanadRow` sheets) does not read dimension codes yet, so the vouchers it posts are unattributed. `resolveDimensionCode` is the rule it will use, with the same refusal, and the change is an addition to that service, not a rewrite.
7. **Bulk assignment.** Attribution is allowed on a draft and refused on a posted line. Bulk assignment on unposted drafts only is the safe version; it is not built.
8. **Hybrid sync.** Dimension master data is cloud-authoritative, like the chart of accounts, and is not in `MASTER_SYNC_TABLES`. Site events do not yet carry attribution, so a site-originated attributed posting needs the sync contract extended. The ledger's replication domain (`accounting_journals`) is unchanged.
9. **Rollup reports** over a parent value's children. Parents are refused as posting targets, so no report double counts; a rollup view is additive.
10. **Journal CSV export with attribution columns.** The journal's export still omits the new columns; the screen shows them.

## §8 Data and history, stated plainly

- Renaming a value changes its label on every report at once and never its totals: reports group by id.
- Archiving a value removes it from the pickers and from new postings. Its history keeps its name and its code, labelled «(بایگانی)» where it appears.
- A value that has ever been posted to is never deleted (the delete route archives it and says so).
- Switching a kind off changes no document; it stops new postings to that kind and removes it from the screens.
- Dates: effective dates are stored as ISO days and shown in Shamsi everywhere.

## Verification

Recorded on `arena/10b8596c-biza-miz`, on the final source. No source file changed after the last of these runs; only this plan changed afterwards.

Environment: the sandbox has 4 GB of RAM and 2 vCPUs, and runs Node 22.22.3, while `package.json` asks for `>=24`. `tsc` needs `NODE_OPTIONS=--max-old-space-size=3072` to finish.

| Step | Command | Result |
| --- | --- | --- |
| Type check | `npx tsc --noEmit` (with the heap setting above) | exit 0 |
| Unit suite | `npm test` | 707 files, 9,284 tests passed, exit 0 |
| Migrations | `npm run db:migrate` on a fresh embedded cluster | 303 applied, including `0216_accounting_dimensions.sql`, exit 0 |
| Database suite | `npm run test:db` after the migration above | 199 of 199 files, 2,745 tests passed, 1 skipped, exit 0 |
| Design suite | `npm run test:design` | 5 files, 38 tests, exit 0 |
| Lint | `npm run lint` (`--max-warnings=0`) | exit 0 |
| Build | `npm run build` | **Not completed in this sandbox.** The kernel's out-of-memory killer stopped it at heap limits of 3072 MB and 3300 MB, and 2400 MB ran out of memory in the same way; the default heap also failed. The base commit `7b1b11c`, built with the same 3072 MB setting, stops the same way, so the cause is the sandbox's 4 GB of RAM. The build is therefore confirmed by the CI build step on this PR, where `.github/workflows/test.yml` sets `NODE_OPTIONS=--max-old-space-size=3072`. |

The one skipped DB test is the row-level-security case in `integration/ai-gateway.integration.test.ts`. It skips itself when `rlsEffective()` is false, which is the case on this cluster, because its role is the bootstrap superuser and superusers bypass row-level security.

Targeted runs during development:

- `integration/expense-import-adapter.integration.test.ts`: 21 of 21 (14 existing, 7 new for the dimension columns).
- `integration/accounting-dimensions.integration.test.ts`: 30 of 30. `integration/accounting-dimension-reports.integration.test.ts`: 12 of 12.
- A mutation check on the report drill-down: an off-by-one in the cell-to-column mapping made both `dimension-report-table.test.ts` and `dimension-reports-panel.test.tsx` fail. The mapping was restored and both pass.
- ESLint with `--max-warnings=0` on every touched file, before the full lint run.

Notes on the run history:

- The first full DB run used the dev database before it was migrated; I had skipped `db:migrate`, which CI runs first. Only `runtime-role-regrant.integration.test.ts` reads the root database, and it failed with `relation "schema_migrations" does not exist`. The database was migrated, that file passed 2 of 2, and the whole suite was re-run. The table above is the re-run.
- The unit suite was first run before the drill-down change; it was re-run on the final code, and the table above is that run.

---

# Status — draft PR open

Delivered as draft PR #898 from `arena/10b8596c-biza-miz`. The PR refs #868 and does not close it: the deferred items below are part of the issue and remain open.

Delivered (§6):

- The line-level model, migration `0216`, the pure rules, the services, and the posting guard on manual journals, drafts and expenses. Reversals mirror the original attribution, including after an archive.
- The expense importer: four optional code columns, resolved to this business's own values and refused by name when unknown or archived.
- Reads and reports: the journal's per-kind filters, the trial balance filter, the cost-centre account card, the account × dimension matrix, profit by profit centre, CSV export and print. A non-zero matrix cell drills into the journal lines behind it.
- Screens: dimension management at `/accounting/dimensions` and the report panel, with searchable selectors and the Project / Cost centre distinction kept in the labels.

Deferred (§7), each with its reason in the plan: payroll attribution, fixed assets, trading postings, receipts and payments (by design, since they settle balances), system-generated opening and carry-forward entries, the Holoo journal-voucher import, bulk assignment, hybrid sync of dimensions, rollup reports, and journal CSV attribution columns.
