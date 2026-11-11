# Issue #1128 — current remaining-work tracker

Updated 2026-10-26 after Wave 19. This supersedes historical «not built yet»
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

## Ordered work still open

1. **Campaign operations and attribution**
   - Calendar across canonical campaign windows with tenant/client/project permission
     filtering, independent of any capped list's totals.
   - Usable manual file/import mapping and validated source provenance, not just
     Wave 19's structured JSON paste/reference.
   - Ad-platform integrations only for genuinely authorized/supported connections,
     with consent, job boundaries and reconciliation; no fabricated connector state.
   - Complete campaign spend/lead/conversion reconciliation and authorized reporting
     surfaces; never sum overlapping period snapshots or call spend claims postings.
2. **Time, resources and campaign-level profitability**
   - Actual time/resource entries, correction/audit and scheduling over existing staff
     identities and Workspace tasks, with project/client separation.
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
   - Combined-preset ordering/KPI/navigation UX. Presets order and label, never grant
     permission or gate unrelated modules; keep the universal default first.
6. **Security, eligibility and rollout closure**
   - Obtain the approved #1110 eligibility matrix. The issue remains open and the
     matrix is absent; do not invent it or mark that P0 acceptance item complete.
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

The full unit suite and selected report/campaign/merge database suites passed in
Wave 19; that is not a certification of every item above. No remaining item is
marked complete merely because it has a related table, a navigation entry or a
passing test elsewhere.
