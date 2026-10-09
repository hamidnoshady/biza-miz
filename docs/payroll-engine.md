# Statutory payroll engine (issue #865)

A module **on top of** the #835 journal-level payroll (`payroll_runs`, advances, commission
settlement), which is unchanged apart from three coordination guards (a month, an advance or a
commission accrual is never booked by both paths).

| Layer | File |
|---|---|
| Pure calculator, rule parser, default components, posting sides | `src/lib/payroll-engine-calc.ts` |
| Rule versions, component catalogue, profiles, recurring items (audited) | `src/lib/payroll-engine-setup.ts` |
| Run lifecycle, payslips, reports, GL reconciliation | `src/lib/payroll-engine-runs.ts` |
| Schema, RLS, immutability triggers | `migrations/0216_payroll_engine.sql` |
| API | `src/app/api/ledger/payroll/engine/**` (`payroll.view` / `payroll.manage`) |

**Workflow:** `draft → calculated → reviewed → approved → posted → paid → closed` (cancel before
approval). From `approved` on, the run and its payslips are frozen by DB triggers; corrections are
`supplemental` runs whose insurance and tax are computed on the cumulative month.

**Rules:** `payroll_rule_sets` is append-only and versioned; a run snapshots the version in force on its
accrual date. The Iranian template carries the statutory shares (7 / 20 / 3 %, 30-day month, 140 %
overtime). The yearly Rial figures (insurance ceiling, tax exemption, brackets) must be entered by the
business from the current budget law / SSO circular — nothing is assumed.

**Posting:** accrual `Dr 5200/5220 (per component mapping) / Cr 2300, 2460, 2470, 1260, 2490`; included
commission reclassifies 2300 instead of expensing again; payment `Dr 2300 / Cr cash|bank`. Both go
through `postExactJournalEntry` (fiscal locks apply), keyed by the run.

**Reports** (`GET /api/ledger/payroll/engine/reports/{register|employee-card|insurance|tax|employer-cost|reconciliation|comparison|periods}`).

**Not yet:** a dashboard screen for the engine (API only), per-line project dimensions on the journal
(cost allocation is stored per payslip and reported), and official SSO/tax-authority file exports.
