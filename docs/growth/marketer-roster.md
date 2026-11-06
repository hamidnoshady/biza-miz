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
offboarding should deactivate the member until an archival workflow is added.
Owner/admin get the new permissions through the normal role rules;
manager has both explicitly. Other presets receive neither. The permissions do
not grant CRM or Accounting capabilities. Deploy migration 0284 with the normal
migration runner; existing data is not backfilled.

Not yet delivered: edits/deactivation, team hierarchy, territories, prospect
locations with precise geolocation, goals, CRM attribution, visits and GPS, offline
sync, mapping/reporting, external contributor access, online conversion tracking,
and marketing reward settlement. Basic prospect sites and assignments are described in `marketing-operations.md`. Those remaining workflows require their own access, privacy and
financial controls before being exposed. In particular this roster must not be
used as a substitute for a CRM party or as evidence of work performed.
