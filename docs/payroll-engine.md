# Statutory payroll engine (issue #865)

This is a module **on top of** the #835 journal-level payroll (`payroll_runs`, advances and
commission settlement). #835 remains the first “simple monthly” tab and is not duplicated. The
shared guard prevents a month, advance recovery or commission accrual from being booked by both
paths.

## Source map

| Responsibility | Source |
|---|---|
| Exact-Rial calculator: statutory rules, components, proration, payslips, corrections and allocation | `src/lib/payroll-engine-calc.ts` |
| Rule versions, components, profiles, recurring items, audit history and allocation validation | `src/lib/payroll-engine-setup.ts` |
| Run lifecycle, idempotency, payslips, dimensioned posting, reports and reconciliation | `src/lib/payroll-engine-runs.ts` |
| Shared #835/#865 identity, accrual-date default, advances/debt and transaction lock | `src/lib/payroll-errors.ts`, `src/lib/payroll-period.ts`, `src/lib/payroll-advances-service.ts`, `src/lib/payroll-db.ts` |
| Tenant schema, RLS, foreign keys and immutability | `migrations/0216_payroll_engine.sql`, `migrations/0217_payroll_engine_corrections.sql`, `migrations/0218_payroll_engine_audit_and_replay_identity.sql` |
| HTTP boundary and permission checks | `src/app/api/ledger/payroll/engine/**` |
| Accounting screens | `src/app/(app)/accounting/payroll-workspace.tsx`, `payroll-engine-profiles.tsx`, `payroll-engine-rules.tsx`, `payroll-engine-runs.tsx`, `payroll-engine-reports.tsx` |

## Workflow trace: screen → request → authorization → service → storage/posting → response

Every engine route is wrapped in `withTenantScope`. Read routes require `payroll.view`; write
routes require `payroll.manage`. Business IDs come from the authenticated session, not request
bodies. The service additionally validates foreign identifiers with explicit business filters;
tenant tables use forced RLS. Read responses return normalized typed records and the screens
refresh from those responses rather than treating a successful request as the updated source of
truth.

| Workflow | Screen and request | Validation / service | Durable effect and response |
|---|---|---|---|
| Employee payroll file | `PayrollEngineProfiles` → `GET /profiles`, `GET /profiles/[userId]`, `PUT /profiles/[userId]` | `payroll.view` for reads, `payroll.manage` for PUT; `saveProfile` validates text codes, employment type, dates, bigint Rial, insurance/tax identifiers, payment destination, statutory requirements and allocation IDs | In one locked transaction writes `payroll_employee_profiles`, the canonical `employees.employee_code` / `employees.hired_at` when explicitly changed, and append-only `payroll_profile_changes`; returns `PayrollProfile`, then the screen reloads |
| Recurring allowances, deductions and benefits | Profile panel → `GET /items?userId=…`, `POST /items`, `PATCH /items/[id]`, `GET /items/[id]` | Read/write permissions above; `listItems`, `addItem`, `endItem`, and `listItemChanges` validate employee, component, amount and effective dates | Adds or ends effective-dated rows (never deletes to “end” an item); appends actor/time before-and-after audit rows in `payroll_employee_item_changes`; returns the row/history for the panel |
| Rules and components | Rules panel → `GET /rule-sets`, `POST /rule-sets`, `GET /components`, `POST /components`, `GET/PATCH /components/[id]` | `createRuleSet` validates and versions rule inputs; `saveComponent` validates account mappings/effective windows and locks system statutory behavior while keeping business component codes renameable | Rule versions and component before/after audit are append-only; saved catalogue/version is returned to refresh the editor. Component mapping uses the active canonical accounts in the current business chart |
| Create a run | Runs panel → `POST /runs` with period, run type, optional accrual date, commission flag, employee inputs/note and `Idempotency-Key` | `createEngineRun` normalizes the Jalali period, ISO wire date, exact inputs and key; `payroll.manage`; shared business lock | Stores immutable create identity in `payroll_engine_runs.idempotency_payload`, then returns the normalized run. A same-key/same-payload retry returns the original run; a conflict returns 409. Legacy keys lacking provable original payload are marked non-replayable by 0218 and fail closed |
| Edit run inputs | Run detail → `GET /runs/[id]`, `PATCH /runs/[id]` | Typed `merge` is the default; each touched employee ID (including zero-value edits) must belong to the tenant and be active in payroll. Full replacement or removing hidden/deactivated inputs requires explicit `inputMode: "replace"` or `removeEmployeeIds` | Merge applies only supplied overtime, leave and item fields. Other employees and bonuses/allowances/deductions remain in the draft. A saved edit resets the unapproved run to draft; the refreshed response supplies the complete input set |
| Calculate and review | Run detail → `POST /runs/[id]/calculate`, `POST /runs/[id]/review` | `calculateEngineRun` snapshots the effective statutory rule version and profile/component inputs; signed corrections use the approved run’s stored rates and cumulative tax/insurance; lifecycle services enforce allowed transitions | Payslips are calculated and stored as snapshots; service returns the run and slips. Corrections are supplemental runs, never edits to an approved month |
| Approve, post, pay, close or cancel | Run detail → `POST /runs/[id]/[action]` | Every write requires `payroll.manage`; transition checks and shared payroll lock serialize read/modify/write state. Payment validates the selected canonical Financial Account and Jalali-picked payment date | Approval freezes run and slips; posting uses `postExactJournalEntry` and the fiscal-period lock; payment settles the stored net amount; close records the terminal state. Cancel is limited to the pre-approval lifecycle |
| Reports | Reports panel → `GET /reports/{register,employee-card,insurance,tax,employer-cost,reconciliation,comparison,periods}` | `payroll.view`; report filters are validated by the service and malformed period, year, user or run IDs are rejected rather than dropped | Reads immutable payslip snapshots; employee card requires an explicit employee and Shamsi year; comparison accepts explicit period `a` and `b`; reconciliation performs all reads in one repeatable-read, read-only snapshot |

Dates remain ISO/Gregorian in storage and on the internal API only. Date controls and displayed
period/date values use `JalaliDatePicker` and Jalali helpers. Amounts stay integer Rial in the
service/ledger; `useMoney` is the UI boundary for the business-selected display unit.

## Lifecycle and identity

The ordinary workflow is `draft → calculated → reviewed → approved → posted → paid → closed`;
cancellation is limited to the pre-approval states. Once approved, the run and its payslips are
frozen by database triggers. The run’s business/period/type/sequence identity is immutable, and a
payslip cannot move between runs or businesses: 0217 adds lifecycle guards and the composite
`(run_id, business_id)` foreign key.

A create idempotency key is bound to a normalized immutable original request, including period,
run type, accrual-date mode/value, commission inclusion, employee inputs and note. Draft edits do
not rewrite that identity. Migration 0218 marks historical keyed rows as `{"legacy":true}`
because their original request cannot be reconstructed from mutable draft fields; retries for
those keys fail with `idempotency_key_conflict` rather than guessing.

## Calculation and rules

- **Partial months.** Base pay is prorated over the days employed in the Jalali month: hire and
  termination dates intersect the month, capped at the rule’s month basis (normally 30). Recurring
  items are prorated over their own effective window. Payslips retain the contract `base_salary`
  and `worked_days` snapshot.
- **Corrections.** A supplemental run is allowed only after the regular run is approved. Overtime
  hours, unpaid-leave days and input items may be signed. Insurance and tax are recomputed on the
  cumulative month and only the difference is withheld; corrections cannot recover more than the
  amount previously paid/deducted.
- **Employee debt.** A downward correction records `employee_debt` (posted Dr 1260) and sets
  `net_pay = 0`, never a negative net. `outstandingAdvances` is the shared source for active #835
  advances plus #865 correction debt minus recovery on both paths; later regular runs recover it.
- **Exact money.** Calculations use bigint Rial; division rounds half away from zero and allocation
  remainders go to the largest share. No financial calculation depends on floating-point money.
- **Versioned statutory rules.** Rule sets are append-only and effective-dated. Each calculated run
  retains the rule version/snapshot used. Iranian percentage/rate defaults are supplied as a
  template; yearly Rial ceilings, exemptions and brackets are entered from the applicable budget
  law/circular rather than silently hard-coded as current law.
- **Components.** Seeded system keys preserve calculation semantics. Statutory kind, taxable/
  insurable flags, effective dates and active state are guarded; names, business-facing codes and
  ledger mappings are auditable. Custom employer-contribution components cannot bypass the
  calculator’s statutory formula.

## Posting and accounting integration

- **Accrual:** component debit/credit mappings post salary expense/payables, employer insurance,
  payroll tax, deductions, advance recovery and employee debt. Included commission reclassifies
  the existing commission payable; it is not expensed twice.
- **Dimensions:** `allocatePayslip` splits each posting line and any employee debt exactly into
  branch × project buckets. Each balanced entry carries its dimensions on the canonical journal
  entry, and an idempotent posting key identifies `(run, posting_kind, allocation bucket)`.
  Allocation branches/projects are checked against this business on profile save and again at
  calculation; inactive/archived and foreign targets are rejected.
- **Payment:** Dr 2300 / Cr the selected active cash/bank Financial Account, on the selected Jalali
  payment date (or business today). The account must resolve through the canonical account
  resolver; it is not accepted as an arbitrary foreign ID.
- **Fiscal locks:** every posting/reversal uses the existing exact-ledger posting path, so locked
  fiscal periods are enforced without a payroll-specific bypass.
- **#835 boundary:** both paths serialize conflicting payroll mutations with the shared per-business
  advisory lock. The legacy service refuses a period held by the engine, and the engine refuses a
  period held by #835. Commission claims and advance recovery are likewise shared, not duplicated.

## Reports

`GET /api/ledger/payroll/engine/reports/{register|employee-card|insurance|tax|employer-cost|reconciliation|comparison|periods}`
returns payroll register, employee card, insurance/tax summaries, employer cost/allocation,
repeatable-read liability reconciliation, explicit two-period comparison and period summaries.
Strict filters reject malformed `runId`, period, Shamsi year and employee ID. The reconciliation
reads its runs, payslips and ledger values from one `REPEATABLE READ READ ONLY` snapshot.

## Requirement and Definition-of-Done evidence

| #865 requirement / DoD | Implementation | Exact regression evidence |
|---|---|---|
| Payroll is a full engine above #835, not a replacement | `payroll-workspace.tsx`; `payroll-engine-runs.ts`; `payroll-service.ts`; shared period/advance/commission guards | `payroll-workspace.test.tsx` › “keeps the #835 monthly screen as the first tab and adds the engine's tabs”; `integration/payroll-engine.integration.test.ts` › “is idempotent on create and never books a month that the #835 journal-level payroll holds”; `integration/payroll-engine.integration.test.ts` › “recovers an advance once, across the engine and the #835 path” |
| Employee profile and canonical personnel/payroll codes | `saveProfile`, `PROFILE_SELECT`, `employees.employee_code`, `payroll_employee_profiles`; `PayrollEngineProfiles` | `integration/payroll-engine.integration.test.ts` › “edits the canonical personnel code as text, preserves omission and clears an explicit null”; `payroll-workspace.test.tsx` › “exposes the complete employee setup and submits the selected payment account and statutory fields” |
| Employment type, dates, salary, insurance/tax and payment destination | `saveProfile`; profile editor; canonical `resolvePayoutAccount` | `integration/payroll-engine.integration.test.ts` › “validates required insurance, tax and bank fields against the canonical in-tenant chart”; `integration/payroll-engine.integration.test.ts` › “clears a hire date inherited from the canonical team identity when explicitly requested”; `payroll-workspace.test.tsx` › “exposes the complete employee setup and submits the selected payment account and statutory fields” |
| Recurring allowances, deductions and benefits with add/end/history/audit | `addItem`, `endItem`, `listItems`, `listItemChanges`; migration 0218 item-audit table, RLS and append-only trigger | `integration/payroll-engine.integration.test.ts` › “retains recurring-item history after end and makes an identical end idempotent”; `integration/payroll-engine.integration.test.ts` › “forces RLS on every payroll tenant table and isolates item-audit reads and writes for a non-bypass role”; `payroll-workspace.test.tsx` › “adds a recurring payroll item from the employee file with an explicit effective date” |
| Components: create/edit, statutory restrictions, mappings, effective dates and audit | `saveComponent`, `listComponentChanges`; `ComponentEditor`; migration 0216 tables/triggers | `integration/payroll-engine.integration.test.ts` › “creates, edits and audits custom components while locking statutory behavior”; `payroll-workspace.test.tsx` › “creates a component from the payroll UI with a Jalali effective date and canonical ledger mapping”; `payroll-workspace.test.tsx` › “keeps system component codes editable but locks statutory flags and effective dates” |
| Versioned statutory rules and historical snapshot | `createRuleSet`, `ruleSetFor`, `rule_snapshot`; migration 0216 append-only rule-set trigger | `integration/payroll-engine.integration.test.ts` › “preserves the rule version a run used after a new version is entered”; `payroll-engine-calc.test.ts` › “accepts the template and fills defaults”, “taxes progressively above the exemption” and “is exact beyond 2^53” |
| Partial-month base salary and effective-window item proration | hire/termination intersection with the Jalali month; component/item effective windows; stored `base_salary` and `worked_days` snapshot | `integration/payroll-engine.integration.test.ts` › “prorates base pay over the days employed and a recurring item over its own window” and “stops at the termination date”; `payroll-engine-calc.test.ts` › “counts covered days, null for the whole month, capped at the rule basis” and “prorates base pay and keeps a full month exact” |
| Run commission, employee items and corrections | `createEngineRun`, `calculateEngineRun`, `collectCommission`, signed `parseRunInputs` | `integration/payroll-engine.integration.test.ts` › “reserves commission once for an engine run and releases it on cancellation”; “corrects a month with a supplemental run computed on the cumulative month”; “reverses overtime with a supplemental run, carries the debt on 1260 and recovers it next month”; “gives back unpaid leave deducted in error”; `payroll-workspace.test.tsx` › “sends a correction's overtime as a negative number and shows the result as a debt” |
| Lossless draft edits and explicit deletion/replacement | `RunDetail.inputsBody`; `updateEngineRunInputs` merge/replace/removal semantics | `integration/payroll-engine.integration.test.ts` › “merges one typed input without losing allowances, deductions, other employees or inactive inputs”; `payroll-workspace.test.tsx` › “merges a typed edit without dropping an existing manual item or a hidden employee input”; `payroll-workspace.test.tsx` › “only removes hidden employee inputs after the manager explicitly requests it”; `integration/payroll-engine.integration.test.ts` › “refuses malformed run ids, periods and years instead of widening the report” (includes a foreign employee's zero-value merge input) |
| Deterministic create replay and conflict detection | `idempotency_payload`; migration 0218; `createEngineRun` | `integration/payroll-engine.integration.test.ts` › “binds create retries to the immutable normalized request, not later draft edits”; `integration/payroll-engine.integration.test.ts` › “does not infer a pre-0218 idempotency request from mutable draft edits”; `payroll-engine-routes.test.ts` › “binds run creation to all normalized request inputs and the header idempotency key”; `payroll-workspace.test.tsx` › “reuses the idempotency key when the same create request is retried” |
| Draft → calculate → review → approve → post → pay → close; approval immutability | `payroll-engine-runs.ts`; migration 0217 lifecycle guards | `integration/payroll-engine.integration.test.ts` › “calculates, approves, posts, pays and closes a month with exact figures”; `integration/payroll-engine.integration.test.ts` › “keeps an approved run and its payslips immutable, in the service and in the database” |
| Exact accounting, dimensions, fiscal locks and liability posting | `allocatePayslip`, `accrualPostingSides`, `postEngineRun`, `postExactJournalEntry` | `payroll-engine-calc.test.ts` › “is exact beyond 2^53”, “produces a balanced accrual netted per account” and “splits every line and the net exactly, each share balancing on its own”; `integration/payroll-engine.integration.test.ts` › “posts one balanced entry per branch × project bucket, summing exactly to the run”; `integration/payroll-engine.integration.test.ts` › “refuses to post into a locked fiscal period”; `integration/payroll-engine.integration.test.ts` › “reads one snapshot, so a post committed mid-report does not unbalance it” |
| Branch/business/project allocation ownership validation | `assertAllocationReferences` and calculation-time recheck | `integration/payroll-engine.integration.test.ts` › “refuses a branch or project of another business, or one that is closed or archived” |
| Reports: register, annual employee card, insurance/tax/employer cost, period comparison | report route and `payroll-engine-reports.tsx` | `integration/payroll-engine.integration.test.ts` › “refuses malformed run ids, periods and years instead of widening the report” (foreign card refusal and explicit valid comparison included); `payroll-workspace.test.tsx` › “requests the employee card with an explicit Jalali year and compares two explicit periods”; `payroll-workspace.test.tsx` › “reports a reconciliation difference” |
| Tenant isolation and authorization | `withTenantScope`, `payroll.view`/`payroll.manage`, explicit business predicates, forced RLS | `payroll-engine-routes.test.ts` › capability-boundary cases (`%s requires only payroll.view`, `%s requires payroll.manage`, `%s refuses a missing capability before touching its service`) cover every declared read/write; `integration/payroll-engine.integration.test.ts` › “forces RLS on every payroll tenant table and isolates item-audit reads and writes for a non-bypass role” and “refuses malformed run ids, periods and years instead of widening the report” (foreign employee/profile/item inputs); “refuses a branch or project of another business, or one that is closed or archived” |
| Repeatable-read consistency and proven lock waiting | `inSnapshot`; `lockPayroll` | `integration/payroll-engine.integration.test.ts` › “reads one snapshot, so a post committed mid-report does not unbalance it”; `integration/payroll-engine.integration.test.ts` › “waits for the shared per-business lock before writing, proven by Postgres lock state” (checks `pg_locks` before releasing the blocker; `Promise.allSettled` is not used as proof) |
| UI integration, Shamsi display and supported payment selection | payroll workspace/profile/rules/runs/reports panels; `JalaliDatePicker`; canonical Financial Accounts resolver | `payroll-workspace.test.tsx` › “keeps the #835 monthly screen as the first tab and adds the engine's tabs” and “pays an engine run from the selected Financial Account on the selected Jalali date”; `integration/payroll-engine.integration.test.ts` › “pays from the selected canonical leaf account on the selected date and rejects foreign or clearing accounts”; `payroll-section.test.tsx` › “sends the chosen Jalali date as ISO, and the chosen account”, “lets the payment leave a bank account chosen from the chart, not a payroll-only list” and “offers only what the server lists as payment accounts”; `payroll-engine-routes.test.ts` › “passes the selected payout account and date to the locked posting service”; `npm run test:design` and the visual regression plus unchanged-main evidence below |

Official SSO, insurance-submission and tax-authority export files are **not explicitly required** by
issue #865. Payroll figures and statutory summaries are implemented; the external submission
artifacts are separate work and are not represented as complete here.
