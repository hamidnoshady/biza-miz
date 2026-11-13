# Issue #1128 — actual task time declarations

Continuation of merged #1348. Implements the first actual-time register over
canonical Workspace tasks and existing member identities. This is **not** epic
completion, a resource scheduling system, approved payroll time, campaign P&L or
a new billing source.

## Recording and correcting work

The agency project's Work tab now includes a manual time panel. A member selects
an existing task, a Jalali work date, integral minutes and a required description.
The author is always the verified actor; neither request fields nor project
management authority let someone log another person's work.

New entries require `workspace.manage`, the existing Workspace projects activation
write guard, agency industry, project contribution and a task in that exact
project/tenant. Contributors can log new work only on tasks assigned to them;
editors/managers can record their **own** work on other project tasks. Reading
requires `workspace.view` and project view. UI capabilities combine live effective
write permission and project contribution; POST independently rechecks authority.

Corrections append a version for the same worker/task/project/day. Only the worker
can correct their own current positive entry while still authorized on the project.
A contributor can correct old work after task reassignment; reassignment does not
make their earlier declaration uncorrectable. A required explanation is entered
anew in the correction UI. Zero is an explicit void correction, never a root entry.
A void is terminal for that lineage; restoring real work is an explicit new record.
No update/delete rewrites history, and concurrent correction forks are refused.

The browser retains a per-draft request UUID after refusal/retry. Replaying the
same actor/request and normalized payload returns the existing ID without another
entry; reusing that ID for different facts is a conflict. The worker must use
«شروع ثبت جدید» for a genuinely new declaration. Duplicate manual declarations
with new IDs are not independently detected as the same real-world activity.

## Integrity, capacity and reporting

Additive migration `0298_agency_task_time.sql` creates the append-only table with
RLS/FORCE RLS, tenant/user/task/project checks, same-scope lineage and unique
successors/retry IDs. No backfill or modification of old project/contract hours.
Task titles, author names and timestamps are retained with each version; timestamps
are serialized in ISO form for browser/Jalali display. The member-history registry
retains authors through offboarding rather than allowing hard deletion.

A transaction advisory lock serializes **one member/day across all projects in the
tenant**. Storage refuses more than 1,440 effective minutes for that member/day,
including concurrent inserts on different projects. Replaced and void versions do
not consume capacity. This is only an upper-bound consistency check: duration
records do not prove non-overlap, attendance, approved work or verified performance.
There is no start/stop timer, UTC interval allocation, roster or future resource
reservation in this slice.

Reported task project scope cannot be moved; foreign keys preserve referenced
tasks/projects. Task deletion through the existing service returns a clear 409
`task_has_time_history`, with Persian explanation, rather than an opaque SQL error.
The table remains the authority in a delete/insert race.

The panel shows the latest 100 versions and explicitly labels that cap. The exact
whole-project active-minute total is calculated over **all** effective entries in
the same SQL statement snapshot as the history page, not by summing it. Decimal
text preserves aggregate precision. No active positive records means unknown,
not a fabricated zero worked-hours claim. The task selector explicitly states its
200-recent-task cap; this slice does not claim an unlimited task-search picker.

No domain events, invoices, payroll records, accounting entries or labor costs are
created. Existing P&L/contracted-hour calculations and approval semantics are
unchanged; self-reported minutes are not silently converted into billable or
approved hours, hourly revenue, allocated campaign costs or margin. No AI tool can
attest time through this change; the MCP matrix records the real tooling gap.

## Verification

- Full unit/component/contract suite: **18,675 passed**, 8 skipped; **1,526 files
  passed**, 1 skipped. Includes authorization, industry, navigation, loading/design,
  generated MCP matrix and member-history contracts.
- Database integration: **23 passed** across actual time (9) and existing whole-
  project P&L (14). The time suite was rerun (9 passed) after tightening ISO timestamp
  serialization, with an explicit wire-format assertion.
- New tests cover retry replay/conflict; no domain event; immutable correction/void
  history; daily-cap races across projects; single correction branch; tenant and
  same-tenant project/task separation; assignment/role rules and reassignment;
  forbidden impersonation; task-scope/deletion protection; full aggregates beyond
  100 rows; future-date refusal; non-agency refusal; NOBYPASSRLS isolation.
- Component tests pin unknown vs complete totals, read-only authority, retained
  retry IDs/input, server-derived actor identity, locked correction scope and voids.
- Targeted TypeScript, changed-file ESLint and whitespace checks: pass.
- Full production build, full DB suite, browser E2E/visual capture and production
  rollout not run locally. CI/review is still required.

## Remaining work

See [the remaining-work tracker](ISSUE_1128_REMAINING_WORK.md). Resource scheduling,
time approval/billing policy, campaign-ledger dimensions and profitability,
commercial completion/renewals, source integrations/provenance, agency dashboard/
print/AI and eligibility/rollout remain open. Do not invent #1110's missing reviewed
agency eligibility decision or mark the whole request complete from this register.
