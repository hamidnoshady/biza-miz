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
10. ~~Journal CSV export with attribution columns.~~ **Done in this pass.** `src/lib/journal-export.ts` now writes eight columns (کد + نام for each of the four dimension kinds, in `DIMENSION_KINDS` order), positioned between the project column and ثبت‌کننده. Lines without attribution get blank cells. Covered by `journal-export.test.ts` (8 cases).

## §8 Data and history, stated plainly

- Renaming a value changes its label on every report at once and never its totals: reports group by id.
- Archiving a value removes it from the pickers and from new postings. Its history keeps its name and its code, labelled «(بایگانی)» where it appears.
- A value that has ever been posted to is never deleted (the delete route archives it and says so).
- Switching a kind off changes no document; it stops new postings to that kind and removes it from the screens.
- Dates: effective dates are stored as ISO days and shown in Shamsi everywhere.

## Verification

Recorded on `arena/10b8596c-biza-miz` at commit `90cc02b`, which is the final source. The commits after it change documentation only; no file under `src`, `scripts`, `electron`, `bin`, `migrations`, `integration` or `.github` differs from `90cc02b`.

Environment: the sandbox has 4 GB of RAM and 2 vCPUs, and runs Node 22.22.3, while `package.json` asks for `>=24`. `tsc` needs `NODE_OPTIONS=--max-old-space-size=3072` to finish.

| Step | Command | Result |
| --- | --- | --- |
| Type check | `npx tsc --noEmit` (with the heap setting above) | exit 0 |
| Unit suite | `npm test` | 709 files, 9,334 tests passed, exit 0 |
| Migrations | `DATABASE_URL=postgres://pos:pos@localhost:55432/pos npm run db:migrate` | up to date (305 applied, including `0216` dimensions, `0217` deferred cycle trigger, `0218` parent advisory lock), exit 0 |
| Database suite | `DATABASE_URL=… npm run test:db` | 199 of 199 files, 2,745 tests passed, 1 skipped, exit 0 |
| Design suite | `npm run test:design` | 5 files, 38 tests, exit 0 |
| Lint | `npm run lint` (`--max-warnings=0`) | exit 0 |
| Build | `npm run build` with `NODE_OPTIONS=--max-old-space-size=3072` | exit 0. The sandbox has 4 GB of RAM, which was not enough alone, so an 8 GB swap file was added for this run. The only warnings are the existing `jose` edge-runtime notices, which come from `src/lib/platform-auth-edge.ts`. |

The one skipped DB test is the row-level-security case in `integration/ai-gateway.integration.test.ts`. It skips itself when `rlsEffective()` is false, which is the case on this cluster, because its role is the bootstrap superuser and superusers bypass row-level security.

Targeted runs during development:

- `integration/expense-import-adapter.integration.test.ts`: 21 of 21 (14 existing, 7 new for the dimension columns).
- `integration/accounting-dimensions.integration.test.ts`: 30 of 30. `integration/accounting-dimension-reports.integration.test.ts`: 12 of 12.
- A mutation check on the report drill-down: an off-by-one in the cell-to-column mapping made both `dimension-report-table.test.ts` and `dimension-reports-panel.test.tsx` fail. The mapping was restored and both pass.
- ESLint with `--max-warnings=0` on every touched file, before the full lint run.

Notes on the run history:

- The first full DB run used the dev database before it was migrated; I had skipped `db:migrate`, which CI runs first. Only `runtime-role-regrant.integration.test.ts` reads the root database, and it failed with `relation "schema_migrations" does not exist`. The database was migrated, that file passed 2 of 2, and the whole suite was re-run. The table above is the re-run.
- The unit suite was first run before the drill-down change; it was re-run on the final code, and the table above is that run.

### Desktop payload and the size budgets

Two budgets stop the desktop build: the staged runtime (200 MiB) and the installed payload (620 MiB, the runaway detector). The installer gate (175 MiB) was not reached. The first version of this branch broke the first two, and neither budget was raised, bypassed or disabled to pass.

**Root cause, measured.** The cost-centre report panel imported `toCsv` from `src/lib/data-transfer/codecs.ts`. That module holds the XLSX and PDF readers, which load exceljs and unpdf through dynamic imports. Each dynamic import reachable from client code becomes a static client chunk, so the panel shipped about 2.5 MiB of client chunks and 1 MiB of server chunks for two libraries that never run in the browser. On a Linux build, the base commit `7b1b11c` against the first version of this branch differed by 3.745 MiB, and 3.3 MiB of that was these chunks. The pure CSV helpers now live in `src/lib/data-transfer/csv.ts`, which declares no imports, and `codecs.ts` re-exports them (commit `9f893ad`). The Linux difference after the fix is 457,424 bytes (+0.436 MiB).

**Gates on Windows, from CI.**

| Measurement | Gate | First version of the branch (`d6fc640`) | This branch (`90cc02b`) |
| --- | --- | --- | --- |
| Staged runtime | 200 MiB | over the gate; the failing step printed only its message, so the exact figure was not recorded | 198.150 MiB (207,775,699 bytes, 6,968 files) |
| Installed payload, unpacked | 620 MiB | 621.9 MiB | 618.583 MiB (648,631,215 bytes, 9,233 files) |
| Installer | 175 MiB | 161.8 MiB | 161 MiB |

Runs: the packaged job `37979722293` (push) and `37979728260` (pull request) passed every step, including the budget steps. The `desktop shell` job on the pull request's run `37979728266` passed and measured the merge-test commit `9d891aea`. That commit's parents are `7b1b11c` and `90cc02b`, and its tree equals the head's tree (`d77245a9`), so the byte totals are identical. The documentation commit `03401aa` repeats the packaged job on its merge-test commit `f060d26` (tree `fece3d36`, equal to the head's): the packaged payload is 648,631,215 bytes again, and the staged runtime is 207,775,691 bytes, 8 bytes less than the earlier run of the same source. The cause was not investigated; it is far below any gate. `main` at `6ec02b5` packaged to 618.1 MiB unpacked and 161 MiB installer (run `37925908034`).

**What the 620 MiB packaged payload is made of (Windows, head `90cc02b`, run `37979722293`).** Electron runtime, 319.19 MiB: `Business Suite.exe` 234.83 and 19 Chromium and Electron files at the root (84.36). Embedded PostgreSQL, 97.76 MiB in `resources/app.asar.unpacked` (2,240 files; `icudt67.dll` 27.08, `postgres.exe` 8.27), which is the product's database and is not trimmed here. Desktop runtime, 198.15 MiB in `resources/desktop-runtime`: the per-route manifests 71.95, traced packages 55.96, route bundles 15.23, `bin/` 12.12, shared server chunks 11.30, build traces 8.31, client route chunks 8.26, app pages 6.81, client shared chunks 5.06, migrations 1.65. Locales 1.57 and `postgresql-tools` 1.11 make up the rest.

**What the remaining growth is.** Linux, base to head, after the fix, +457,424 bytes in total: client-reference manifests +245 KiB, server chunks +51 KiB, client route chunks +41 KiB, client shared chunks +32 KiB, build traces (`*.nft.json`) +31 KiB, `bin/` +20 KiB, route handlers +13 KiB, migration `0216` +12 KiB. Almost all of the manifest term is the four new API routes: each route's client-reference manifest is about 67 KiB. The 1,047 existing manifests change by a net −24.5 KiB, and on two of them, checked with the absolute build paths normalised, the client-module sets are identical, so that change sits in their numeric IDs and paths and is not attributed to any feature. None of the three new client components appears in any manifest, so they add no manifest bytes. The feature therefore costs about 0.44 MiB: its four API routes, its screens, its server code and its migration.

**The base on Windows is not measured.** Dispatching `verify-shippables` and `build-desktop-installer` with `source_ref=7b1b11c54f9ccb19a82fba69b590d10b10da31ba` from this session returned HTTP 403 (the session token cannot start workflow runs), so the base's staged figure on Windows is missing. If the Linux delta carries over, the base would be about 197.7 MiB. Those two dispatches, run manually on this branch with that `source_ref`, would record it exactly.

**Diagnostics, so a budget failure keeps its numbers.** `src/lib/desktop-size-diagnostics.ts` (pure, with 37 tests) and `scripts/desktop-size-diagnostics.ts` (a `tsx` CLI) write the totals, the categories, the traced packages, the largest files and a manifest. They run `if: always()` after each budget step, and the reports upload even when a budget fails (`desktop-staged-runtime-size` and `business-suite-desktop-size-report`). Both manual workflows take a `source_ref`; a `source_ref` run is never a release: `RELEASE_BUILD` evaluates to false for it, the value the branch's pushes get, and on run `37979722293` the release job was skipped. A `source_ref` dispatch itself has not run yet, because of the 403 above. Provenance now records the checked-out commit rather than `GITHUB_SHA`.

**Follow-ups, not in this PR, each with its measured size.**

1. Per-route client-reference manifests: 1,051 files, 71.95 MiB on Windows, the largest term. Every route handler carries a copy of the client-module map. This is Next's build output, not feature code, so it is a separate framework-level change.
2. Build traces (`*.nft.json`): 1,054 files, 8.31 MiB on Linux. Only Next's build code reads them (`next/dist/build` and `next/dist/esm/build`); the app, `electron/` and `scripts/` do not. Removing them from the staged runtime needs a `next start` smoke test from the staged runtime first.
3. Traced packages to verify before any change: `amphtml-validator` (3.83 MiB), Next's compiled babel bundles (2.77 MiB), and `capsize-font-metrics.json` (4.10 MiB). Whether the app can reach them at runtime is not verified.

---

# Status — draft PR open

Delivered as draft PR #898 from `arena/10b8596c-biza-miz`. The PR refs #868 and does not close it: the deferred items below are part of the issue and remain open.

Delivered (§6):

- The line-level model, migration `0216`, the pure rules, the services, and the posting guard on manual journals, drafts and expenses. Reversals mirror the original attribution, including after an archive (`postExactMirrorEntry` carries all four dimension columns through `dimensionMirror: true`).
- The expense importer: four optional code columns, resolved to this business's own values and refused by name when unknown or archived. Expense duplicate detection now keys on the four dimension IDs too (SQL adapter, not the generic rule registry).
- Concurrency hardening (migrations `0217` and `0218`): a deferred `CONSTRAINT TRIGGER` re-walks the ancestor chain at COMMIT for cross-row cycles, and a `BEFORE` trigger takes an xact-level advisory lock keyed on (business, kind) so concurrent parent changes serialise; under REPEATABLE READ a deferred trigger alone is not enough. Covered by new tests in `accounting-dimensions.integration.test.ts`.
- Journal CSV/XLSX export now carries eight dimension columns (کد + نام per kind) with blank cells on unattributed lines (`journal-export.ts`), covered by `journal-export.test.ts`.
- Reads and reports: the journal's per-kind filters, the trial balance filter, the cost-centre account card, the account × dimension matrix, profit by profit centre, CSV export and print. A non-zero matrix cell drills into the journal lines behind it.
- Screens: dimension management at `/accounting/dimensions` and the report panel, with searchable selectors and the Project / Cost centre distinction kept in the labels.
- The desktop size budgets pass on the PR head with the first version's growth removed. The growth was one import: the report panel reached the codec module's spreadsheet and PDF libraries. The fix, the measurements and the follow-ups are in the Desktop payload section above. The staged runtime is 198.150 MiB against 200, and the installed payload 618.583 MiB against 620.
- Size diagnostics run on every desktop build, after the budgets, and their reports upload even when a budget fails.

Deferred (§7), each with its reason in the plan: payroll attribution, fixed assets, trading postings, receipts and payments (by design, since they settle balances), system-generated opening and carry-forward entries, the Holoo journal-voucher import, bulk assignment, hybrid sync of dimensions, rollup reports, and journal CSV attribution columns.

Open at this writing:

- The base commit's staged figure on Windows. It needs the two `source_ref` runs described in the Desktop payload section, which this session could not start.
- `visual regression` fails on this branch with the same file and figure as on `main`: `docs/design/visual/accounting-expenses.png` at 4.06%. The baseline is not re-recorded here.
