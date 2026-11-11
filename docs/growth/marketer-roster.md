# Marketer roster foundation (issue #900)

This is an incremental roster, not the complete marketer management subsystem.
Growth owns the operational record; employee identity remains the tenant's user,
and external contractors, affiliates and agencies are name-only records. Creating
one does not create a login, grant permissions, create a CRM party or consent,
calculate a reward, or post accounting entries. Employee names are read from the
current membership and deactivated members are shown as such.

The roster belongs to one internal tenant branch per record (not a marketing
territory). Reads and writes are restricted to the current member's accessible
active branches. Staff must be active and authorized for that branch, and may have
only one roster record per tenant. Database composite foreign keys protect tenant
affinity; forced RLS enforces tenant isolation, while branch checks remain in the
service/API. Creation and its audit record share a transaction. No compensation or
location data is stored. Search is server-side with bounded pagination.

`marketers.view` opens the page and its list; `marketers.manage` permits creation
and the staff/branch picker. Custom roles need both to use the page and create
records. Roster references deliberately restrict hard deletion of linked staff;
The operational roster can be deactivated independently of the user account, without deleting history.
Owner/admin get the new permissions through the normal role rules;
manager has both explicitly. Other presets receive neither. The permissions do
not grant CRM or Accounting capabilities. Deploy migration 0284 with the normal
migration runner; existing data is not backfilled.

Not yet delivered: team-based visibility and approval hierarchy, territories, prospect
locations with precise geolocation, goals, CRM attribution, visits and GPS, offline
sync, mapping/reporting, external contributor access, online conversion tracking,
and marketing reward settlement. Basic prospect sites and assignments are described in `marketing-operations.md`. Those remaining workflows require their own access, privacy and
financial controls before being exposed. In particular this roster must not be
used as a substitute for a CRM party or as evidence of work performed.

## Roster lifecycle

`marketers.manage` permits deactivation/reactivation and renaming active external
records. Employee names remain owned by the shared user membership; neither branch,
kind, user identity nor permissions are changed here. Deactivation is blocked
while planned or in-progress assignments exist; assignment creation and the
status change serialize on the marketer record. A manager must complete or cancel
open tasks first. Reactivating an employee requires a currently active member
with access to that active branch. No linked member is automatically deactivated,
and a user deactivated elsewhere can still leave open work requiring manager
intervention. Revisions detect stale writes, and each change and its audit entry
commit together. The list displays the current external name, not a historical
name snapshot. Migration 0290 adds the revision with an initial value of zero.
This does not implement teams, reassignment, external login, visit evidence or
compensation; see the incremental supervisor links below.

## Organizational supervisor links (incremental)

Migration `0297` adds an optional direct supervisor on each roster record.
A `marketers.manage` user may set or clear this relation from the roster; the
picker searches and pages only active employee marketers in the same actionable
active branch, and the server independently validates their active membership
and branch access. A staff marketer receiving a new link must also be an active
member with branch access; clearing a link remains possible when they are ineligible. External collaborators may be supervised but cannot be a
supervisor in this increment. The tenant/branch-composite foreign key prevents
cross-scope references. A transaction-level per-tenant graph mutex, cycle check,
optimistic roster revision and atomic audit keep concurrent changes consistent.
Deactivating a supervisor is blocked until all directly supervised roster
records, including inactive ones, are reassigned or cleared. Clearing an inactive
marketer's own link remains possible. When a linked supervisor's user is later
suspended or loses branch access outside Growth, the relationship is retained
and shown as ineligible; it does not independently modify membership state.

These are current operational reporting links, not a team object, a full
historical org chart, a territory assignment, an approval chain, or a permission
grant. Audit records capture the old and new IDs, but are not a complete
point-in-time hierarchy product. Reporting to a supervisor never grants access to
subordinates' assignments, CRM, Accounting, rewards or sensitive data. Offset
picker pages can shift during concurrent changes, and selection is revalidated on
save. Existing roster records start with no supervisor. Team-scoped visibility,
reassignment, effective-dated structures, Hybrid site restrictions, GPS, offline
sync, online attribution and financial workflows remain separate work under #900.
