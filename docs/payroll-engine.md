# Statutory payroll engine (issue #865)

A module **on top of** the #835 journal-level payroll (`payroll_runs`, advances, commission
settlement). #835 stays the active "simple monthly" path, unchanged apart from three coordination
guards: a month, an advance and a commission accrual are never booked by both paths.

| Layer | File |
|---|---|
| Pure calculator: rules, components, proration, payslip, corrections, posting sides, exact allocation | `src/lib/payroll-engine-calc.ts` |
| Rule versions, component catalogue, profiles, recurring items (audited), allocation reference checks | `src/lib/payroll-engine-setup.ts` |
| Run lifecycle, payslips, dimensioned posting, reports, snapshot reconciliation | `src/lib/payroll-engine-runs.ts` |
| Shared with #835: idempotency keys, default accrual date, outstanding advances/debts, transactions | `payroll-errors.ts`, `payroll-period.ts`, `payroll-advances-service.ts`, `payroll-db.ts` |
| Schema, RLS, immutability triggers | `migrations/0216_payroll_engine.sql`, `migrations/0217_payroll_engine_corrections.sql` |
| API | `src/app/api/ledger/payroll/engine/**` (`payroll.view` / `payroll.manage`) |
| Screens | Accounting → حقوق و دستمزد: `payroll-workspace.tsx` tabs (#835 monthly, runs, employee files, rules & components, reports) |

## Workflow

`draft → calculated → reviewed → approved → posted → paid → closed`; cancel is allowed up to
`reviewed`. From `approved` on, the run and its payslips are frozen by DB triggers, and a run's
identity (business, period, type, sequence) is immutable. A payslip cannot move between runs or
businesses: the guard checks both the old and the new run, and a composite FK
`(run_id, business_id) → payroll_engine_runs(id, business_id)` ties it to its own business's run.

## Calculation

- **Partial months.** Base pay is prorated over the days employed in the month: hire and termination
  dates intersected with the Jalali month, capped at the rule's month basis (30). A full month is paid
  in full, whatever its calendar length. A recurring item is prorated over its own effective window
  intersected with employment. The payslip stores `base_salary` (the contract rate) and `worked_days`.
- **Corrections** are `supplemental` runs on an approved month. Insurance and tax are recomputed on the
  cumulative month and only the difference is withheld. Overtime hours, unpaid-leave days and item
  amounts are **signed**, so a correction can reverse an earlier one. Corrections are priced at the
  regular run's stored rate, and can never take back more than was paid or deducted.
- **Employee debt.** When a correction leaves the employee owing money, the payslip records
  `employee_debt` (posted Dr 1260) and `net_pay = 0`; it never records a negative net.
  `outstandingAdvances` is the single source of what a member owes (advances + engine debts −
  recoveries on both paths), and later regular runs recover from it.
- **Exact money.** All amounts are bigint Rial; division rounds half away from zero; allocation
  remainders go to the largest share.

## Rules

`payroll_rule_sets` is append-only and versioned. Each run snapshots the rule version in force on its
accrual date. The Iranian template provides the statutory shares (7 / 20 / 3 %, a 30-day month,
140 % overtime). The yearly Rial figures (insurance ceiling, tax exemption, brackets) must be entered
by the business from the current budget law and SSO circular; the engine assumes none of them.

## Posting

- **Accrual:** Dr 5200 / 5220 (per component mapping); Cr 2300, 2460, 2470, 1260 (advance recovery),
  2490. Employee debt is posted Dr 1260. Included commission reclassifies 2300 instead of being
  expensed again.
- **Dimensioned:** the accrual is posted as one balanced entry per cost-allocation bucket
  (branch × project), carried on `journal_entries.location_id` / `project_id`. `allocatePayslip`
  splits every line and the debt exactly. Each entry is keyed
  `(payroll_engine_accrual, run, posting_kind = alloc:<location|->:<project|->)` under the ledger's
  unique posting index. The run stores `accrual_entry_ids`.
- **Allocation targets:** a branch or project used in an allocation must belong to the business and
  be active or unarchived. This is checked when the profile is saved and again at calculation
  (`invalid_cost_allocation`).
- **Payment:** Dr 2300 / Cr cash or bank, undimensioned.
- All entries go through `postExactJournalEntry`, so fiscal locks apply.

## Reports

`GET /api/ledger/payroll/engine/reports/{register|employee-card|insurance|tax|employer-cost|reconciliation|comparison|periods}`.
Filters are strict: a malformed `runId` returns 400 `invalid_run_id`, and a malformed period or year
returns 400 `invalid_period`; neither is silently dropped. The reconciliation reads everything from
one `REPEATABLE READ READ ONLY` snapshot.

## Requirement → source → test

| #865 requirement | Source | Test |
|---|---|---|
| Statutory earnings, insurance (ceiling), progressive tax, exact Rial | `computePayslip`, `progressiveTax` | `payroll-engine-calc.test.ts` › computePayslip, exact arithmetic |
| Versioned rules, snapshot per run | `createRuleSet`, `ruleSetFor`, run `rule_snapshot` | integration › preserves the rule version |
| Components and recurring items, audited | `saveComponent`, `addItem`, `*_changes` tables | integration › audits profile and component changes |
| Partial months (hire / termination / item windows) | `coveredDays`, `prorate`, `calculateEngineRun` | calc › partial months; integration › partial months |
| Supplemental corrections, signed OT / leave / items | `computePayslip` (supplemental), `priorTotals` | calc › signed corrections; integration › signed corrections |
| Employee debt, recovered once across both paths | `employeeDebt`, `outstandingAdvances` | integration › reverses overtime…recovers it next month; recovers an advance once (+ concurrent) |
| Lifecycle and immutability in service and DB | `assertTransition`, 0216/0217 triggers | integration › immutable; database identity |
| Dimensioned GL posting, exact split, idempotent | `accrualBuckets`, `allocatePayslip`, `postEngineRun` | calc › allocatePayslip; integration › dimensioned posting, racing double post |
| Tenant-safe allocation references | `assertAllocationReferences` | integration › refuses a branch or project of another business |
| Fiscal locks | `postExactJournalEntry` | integration › refuses to post into a locked fiscal period |
| No double booking with #835 | period / advance / commission guards | integration › idempotent…never books a month #835 holds |
| Reports with strict filters | `payrollRegister`, `employeePayrollCard`, `periodComparison` | integration › strict report filters |
| GL reconciliation, snapshot-consistent | `payrollLiabilityReconciliation`, `inSnapshot` | integration › reconciliation snapshot |
| Dashboard screens (Shamsi dates, money unit, skeletons) | `payroll-workspace.tsx`, `payroll-engine-*.tsx` | `payroll-workspace.test.tsx`; `test:design` |

**Out of scope (not required by #865):** official SSO list (DBF) and tax-authority file exports. The
insurance and tax summaries provide the figures those files need.
