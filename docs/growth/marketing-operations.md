# Marketing targets and assignments (issue #900)

This increment adds Growth-owned prospect **sites** and operational assignments.
A site has a branch responsible for it, a label, city and neighborhood, and an
optional reference to an existing canonical party. The site is not a tenant
branch, a new customer, a CRM lead or a consent record. Parties are found via
the existing directory API; no party data is written by Growth. The target list
projects only whether a party is linked, not the party's private profile.

A manager can assign an active marketer and target in the same authorized branch,
set a date (displayed in Jalali) and move work from planned to in progress,
completed or canceled. Completion is only a task state, **not** evidence of a
visit, qualification, a conversion, or an accounting event. Only one open task
per marketer/target is allowed at a time; after completion/cancellation another
may be created. The status update locks the row, compares the expected prior
state and audits the change in the same transaction. Reassignment can be done by
canceling and creating a new task; the old record remains for history.

Targets use `marketing_targets.view/manage`; tasks use
`marketing_assignments.view/manage`. Creating targets also requires
`parties.view` (even for an unlinked site), because that flow can link the shared
directory. Management pickers reveal only the branch-scoped operational labels
and marketer names necessary to assign work. Owner/admin and manager receive
these keys; other roles do not by default. Custom roles need the corresponding
view and management keys for the pages. Directory access does not grant CRM
write, consent, Accounting or compensation permissions. Writes and lists use the
current membership's authorized active branches; composite foreign keys enforce
tenant and branch affinity even on direct writes. Both tables have forced tenant
RLS. Migration 0285 follows 0284; no data is backfilled.

Current boundaries: there is no duplicate-site review, edit/archive UI, team
hierarchy, precise address/coordinates, route planning, lead creation, consent,
verified attribution or evidence. Links to a party later merged/archived are not yet
repointed automatically; review them in CRM before relying on them. Options are
currently capped at the first 500 active targets and marketers per branch; a
searchable picker is required for larger rosters. The assignment is made to the
canonical branch-authorized active staff membership (or an external roster
record), but does not grant that contributor a login or a self-service task
queue. Site-specific hybrid contributor restrictions and offline synchronization
are not implemented. No personal GPS or continuous tracking is collected.

An initial, separate operator-reported lead touchpoint flow is described in
[marketing-touchpoints.md](marketing-touchpoints.md). It does not turn an
assignment into verified visit, conversion, sale or compensation evidence.
