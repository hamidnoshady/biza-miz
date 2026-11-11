# Issue #1128 — current remaining-work tracker

Updated 2026-10-26 after Wave 21. This supersedes historical «not built yet»
statements in the original plan where later merged waves shipped those features.
It is an implementation queue, not a claim that the epic checklist is complete.

## Preserved baseline

The industry foundation, operating-profile settings and seven Workspace blueprints
are already implemented. Later merged waves added canonical CRM briefs/proposals/
client campaigns, scoped media review, billing and commercial workflows,
project-linked reimbursable costs/vendor procurement, vendor settlement, whole-project
P&L and approved/unbooked purchase cancellation. Keep those canonical entities,
permissions and accounting invariants; do not build a parallel engine.

Wave 19 adds manual period campaign evidence, immutable correction history and
uncertainty-aware CPL/CPA/ROAS. It does not complete campaign operations as a whole.
See `ISSUE_1128_WAVE15_PROGRESS.md` through `ISSUE_1128_WAVE19_PROGRESS.md` for recent
scope/verification details rather than interpreting every old unchecked box as absent.

Wave 20 adds a permission-filtered date-range campaign agenda, explicit browser-local
CSV mapping/preview into the existing report form, and combined-specialty blueprint
recommendations. See `ISSUE_1128_WAVE20_PROGRESS.md` for limits and verification.

Wave 21 adds manual actual task-time declarations with immutable own-entry
corrections/voids, retry safety, daily capacity checks and whole-project active
minute totals. See `ISSUE_1128_WAVE21_PROGRESS.md`; these are not approved payroll,
billable hours or ledger labor costs.

## Ordered work still open

1. **Campaign operations and attribution**
   - **Delivered in Wave 20:** bounded Jalali range agenda over canonical windows,
     tenant/client/project filtering before pagination, and explicit manual CSV
     mapping/currency/one-row preview into the immutable report form.
   - Source provenance validation beyond a local file fingerprint remains open;
     the source reference and performance measurements are still human declarations.
   - Ad-platform integrations only for genuinely authorized/supported connections,
     with consent, job boundaries and reconciliation; no fabricated connector state.
   - Complete campaign spend/lead/conversion reconciliation and authorized reporting
     surfaces; never sum overlapping period snapshots or call spend claims postings.
2. **Time, resources and campaign-level profitability**
   - **Delivered in Wave 21:** actual task-time self-declarations, own correction/
     void history and concurrent per-worker daily capacity checks over existing
     members/tasks with tenant/project separation.
   - Resource scheduling/reservations, interval overlap detection, approval and
     deliberate billing/cost-allocation policies remain open. The manual register
     does not approve, bill or price labor.
   - Campaign dimensions on existing accounting flows and defensible campaign P&L
     tied to the ledger; preserve whole-project exact aggregates. Missing hours,
     revenue or allocation are unknown, not zero or an invented margin.
3. **Commercial/accounting completion**
   - Agency-owned procurement where the existing client-project purchase scope does
     not fit; preserve existing vendor approval, payable and settlement engines.
   - Explicit customer-advance application/reconciliation and overdue balance views
     using existing invoice/payment facts. Do not create a second receivables ledger.
   - Invoice/cost tie-outs and relevant concurrency/permission tests for these paths.
4. **Renewals and versioned scope**
   - Explicit engagement renewal and immutable scope/version lineage over canonical
     proposals/contracts/change requests; preserve existing approvals and documents.
5. **Presentation and bounded automation**
   - Agency dashboard/report widgets, evidence-aware client/campaign reports, and
     print templates on the shared rendering/presentation-policy infrastructure.
   - AI drafting/report assistance only behind real authority, audit and human
     approval; no tool that invents measurements, attests reconciliation or silently
     posts financial facts.
   - **Delivered in Wave 20:** combined primary/secondary specialty recommendations
     on the existing blueprint catalogue, without changing template eligibility.
   - KPI/navigation preset UX remains open. Presets order and label, never grant
     permission or gate unrelated modules; keep the universal CRM default first.
6. **Security, eligibility and rollout closure**
   - Obtain the approved agency-inclusive #1110 eligibility decision. The open
     issue contains a proposed older-industry matrix but no `advertising_agency`
     row; do not invent the missing policy or mark that P0 item complete.
   - Verify industry + service state + effective role + project membership across
     UI/API/AI/background boundaries, including two clients in one tenant and
     cross-tenant/RLS/IDOR cases for each newly added workflow.
   - Fresh-install and additive-upgrade checks, accounting tie-outs, browser/RTL/
     presentation checks, operational rollout/rollback checklist and CI/review.
   - Reconcile every #1128 acceptance checkbox against evidence before closing it.

## Standing implementation constraints

Use the four existing apps, conditional Workspace, canonical parties/projects,
shared media store and saved presentation policy. Keep Persian RTL/Jalali and the
existing accounting/domain engines. Additive migrations only; no mass backfill,
no unauthorized AI posting, no navigation-only authorization and no automatic
eligibility expansion for unrelated industries. Unknown data stays unknown.

Validation details for each delivered slice are recorded in its wave progress
file; that is not a certification of every item above. No remaining item is
marked complete merely because it has a related table, a navigation entry or a
passing test elsewhere.
