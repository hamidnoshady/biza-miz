# Issue #1128 — planned task/member resource reservations

Continuation of merged #1356. Adds bounded resource scheduling over the existing
Workspace members, projects and tasks. It does **not** close #1128, attest work,
approve actual hours, create a staff identity engine or post accounting facts.

## Authority and member workflow

The agency project's Work tab now includes a reservation panel alongside the
separate actual-time register. Members with Workspace view and project view can
read that project's reservations. Creating, rescheduling or cancelling requires
both live `workspace.manage` through the existing projects service-activation
write guard and project **management** in the source service. An editor with a
platform write permission still cannot allocate resources as a manager.

A new reservation names an existing task in that exact tenant/project and an active
member explicitly holding owner/manager/editor/contributor membership in the same
project. A business-wide override alone does not make someone a schedulable project
member. Planning does not grant the worker any new platform permission, change task
assignment, or impersonate that worker as the author. The verified manager is the
actor; target member and author have separate retained foreign keys/name snapshots.

Choose a bounded date filter, task and member; enter Jalali start/end dates, clock
times, an **explicit UTC offset** (`Z` or e.g. `+03:30`) and a required explanation.
The browser never guesses timezone from its own location or interprets a naive
local timestamp. A preview displays the canonical instants in the business's
primary-branch timezone; changing input invalidates it. A separate confirmation
saves the preview. Each positive interval is minute-aligned and at most 24 elapsed
hours. Offsets are fixed for the entered instants, not an automatic IANA/DST wall-
clock resolver; the preview must be checked. The API also accepts independently
offset-qualified start/end instants and normalizes them to UTC.

Rescheduling appends a version for the same worker/task/project; changing those
identities requires cancelling the old reservation and creating a new one. Cancelling
requires a reason and preserves the exact prior interval and resource/task identity.
Only a current reserved version can be superseded; cancellation is terminal in that
lineage. Any currently authorized project manager may change the schedule, including
a different manager from its original author, with both actors retained in history.
An inactive/offboarded/removed worker can still have a reservation cancelled, so
stale allocations are not made impossible to release by departure.

## Storage and conflict behavior

Additive migration `0299_agency_resource_reservations.sql` creates an append-only
RLS/FORCE-RLS table; there is no backfill. The insertion trigger checks tenant/task/
project/worker scope, required active project membership for positive plans,
same-scope current correction lineage and cancellation interval preservation.
Unique successor and tenant/actor/request constraints protect forks and retries.
Task scope cannot move once reserved, and referenced tasks/projects/member identities
cannot be deleted out from under history. The existing task-delete service returns
a clear `task_has_reservation_history` 409/Persian explanation for the new FK.
Both author and scheduled worker enter the existing member-history retention registry.

A per-tenant/worker advisory lock serializes **all** reservation writes for that
person, not separate locks per project/day. Active half-open intervals `[start,end)`
are checked across all tenant projects, excluding superseded versions and cancelled
plans. Adjacent bookings are allowed; overlapping and cross-midnight races are
refused. This check is at storage as well as the guarded service boundary. It does
not require a new extension or duplicate scheduling engine.

A manager may receive a generic conflict because a shared worker is busy elsewhere;
no other project's/client's name, notes, counts, IDs or plan list is returned.
Project-specific reads still require that project's access. Retry IDs survive UI
refusal/unknown results: an identical normalized actor/request payload returns its
existing ID, while different facts with the same key conflict. Preview alone never
writes. New manual IDs do not evade resource overlap checks.

## Calendar and capacity limits

The reservation history uses a business-timezone day window of at most 93 inclusive
days. Each page has at most 100 versions and an explicit next offset; all pages can
be loaded independently of a capped metrics list. Superseded/cancelled history is
labelled, not silently treated as current bookings. A move outside the selected
window may leave only the replaced version in that window; the success notice says
to change the date filter to see the new slot. Concurrent edits can move rows between
offset pages, so the UI deduplicates IDs and explains refreshing from the first page.
No page-derived capacity or financial total is reported. Lookups explicitly label
limits of 200 recent tasks and 200 active contributing project members.

This is exclusive **planned interval** allocation, not working-hours calendars,
leave/holiday rules, fractional utilization, overtime approval, maximum contractual
capacity, actual start/stop intervals or verification that work occurred. It neither
subtracts reservations from the actual-time ceiling nor counts actual duration
entries as planned interval occupancy. Those duration records have no intervals
from which non-overlap could honestly be proved. Root reservations can describe
retrospective plans; they are never automatically marked executed.

No domain event, actual-time entry, invoice, payroll record, expense, payable or
journal entry is created. Existing project P&L is unchanged. No AI reservation-write
or time-attestation tool is introduced; the MCP matrix records the new boundary.

## Verification

- Full unit/component/contract suite: **18,712 passed**, 8 skipped; **1,529 files
  passed**, 1 skipped. Includes API/industry/navigation, design/loading, MCP drift
  and author/worker member-history contracts.
- Database integration: **34 passed** across reservations (11), actual time (9) and
  whole-project P&L (14). The command wait timed out just before test completion;
  the retained process/log confirmed all three files completed successfully.
- New database tests cover normalized retry replay/conflict, no actual-time/event
  creation, immutable/rescheduled/cancelled history, stale and concurrent branches,
  cross-project worker overlap races, adjacency and cross-midnight intervals,
  active/contributing staff constraints, cancellation after offboarding/removal,
  different-manager audit, two-client hidden project separation, task/deletion scope,
  business-timezone filtering, >100-row pagination, industry and NOBYPASSRLS isolation.
- Pure/component/API tests cover strict offset/minute/window validation, no preview
  write, stale-preview clearing, explicit confirmation, locked cancellation scope,
  preserved retry input/IDs, read-only controls, page/window changes and generic
  conflict responses without hidden-project metadata.
- Targeted TypeScript, changed-file ESLint and whitespace checks: pass. MCP coverage
  regenerated: 1,264 routes, 17 tenant tool gaps, zero platform/unclassified gaps.
- Full production build, full DB suite, browser E2E/visual capture and production
  rollout not run locally. CI/review remains required.

## Still open

See [remaining work](ISSUE_1128_REMAINING_WORK.md). Advanced capacity/availability
policy, actual-time approval/billing, campaign-ledger dimensions/profitability,
commercial completion/renewals, integrations/provenance, dashboard/print/AI and
approved eligibility/rollout remain open. The missing reviewed agency eligibility
decision in #1110 is not invented or satisfied by this reservation register.
