# Reported marketer–lead touchpoints (issue #900, incremental)

Migration `0286` adds a Growth-owned, append-only report that links an **existing**
CRM lead to one existing assignment, its target, marketer and branch. An operator
chooses a contact channel and a value from the CRM source vocabulary. The server
records the creation time and actor; the channel and source are **user-attested**.
They are not proof that contact occurred, a GPS visit, consent, lead conversion,
last-touch acquisition source, sales attribution, a commission, or financial
compensation. It creates no CRM lead, CRM-owned activity or editable timeline
record, or accounting entry, and never changes a lead's source, a party's first/last source, or consent.
The existing CRM lead editor is a separate workflow and can edit a lead's source;
this increment does not establish global first-source immutability for CRM leads.

## Access and data boundaries

- Lists require `marketing_attribution.view`; lead IDs and names are redacted unless
  the viewer has **both** `crm.view` and `crm.manage`. Lists and assignments are
  limited to the actor's actionable branches. This is separate from any CRM access
  granted by another role, and is not a marketer self-service capability.
- Recording and its assignment options require `marketing_attribution.manage`,
  `marketing_assignments.view`, `crm.view` and `crm.manage`. CRM lead search goes
  through the existing CRM API (also requiring CRM view/manage). Search is
  paginated. Nothing is created for an inaccessible branch, nonexistent lead or
  canceled assignment or inactive target; completed assignments can still receive
  reported touches. If a lead is already converted and the target has a linked party, the parties must match. An unconverted lead can be linked;
  later conversion is not revalidated, so do not infer a party identity from it.
- Forced tenant RLS and composite foreign keys enforce tenant and branch affinity;
  the server resolves tenant and actor from the authenticated session. The audit
  entry and event commit in one transaction. An event is immutable to ordinary
  operations, with actor nulling only through the existing member deletion FK.
  Confirmed factory reset and hard delete may clear it transactionally.
- CRM service-retention purge leaves leads referenced by Growth touchpoints (and
  their dependent records) intact as a blocked, cross-app dependency; independent
  eligible leads can still be purged. This retention has privacy consequences and
  requires an explicit cross-app deletion/retention policy before production use.
  The CRM purge manifest reports this blocked scope. Full tenant reset/hard delete
  clears Growth history in dependency order, but is not a substitute for a
  narrowly scoped privacy-erasure workflow.

## Retry and remaining scope

The create API requires a client-generated UUID idempotency key, unique per
business. A retry with the same key, actor and exact payload returns the original
record; reuse with different details conflicts. Audit failure rolls back both
writes. The UI retains the key only in memory for a same-payload retry while the
form remains mounted. A refresh, or changing and submitting a different payload
after an ambiguous failure, may duplicate an event. No durable offline queue or
exactly-once guarantee is provided.

The event time is displayed in the branch timezone with Jalali formatting; it is
when the server recorded the report, not a claimed or verified contact time.
There is no link to a specific CRM lead page because that page does not yet
consume lead deep links; a lead-specific read-only projection is available from
the CRM lead list to appropriately authorized users. Assignment options and lead
results are paginated. This slice does not implement team hierarchy, CRM
conversion attribution, GPS/visit evidence, offline sync, online
tracking, rewards/settlement, analytics, or the remainder of issue #900.

## CRM lead projection

CRM's lead list can show a read-only, paginated projection of reported Growth
interactions for a selected lead. The projection reads the original immutable
Growth records; it creates no second activity, visit, consent, lead source,
conversion, attribution, or financial record. It explicitly labels the events as
reports, with the server recording time displayed in the branch's Jalali timezone.
Existing assignment, target and marketer labels are current, not historical
snapshots. A converted lead remains a lead-specific view: a later conversion to a
party is not proof that its previous interactions belong to that party.

The viewer must have `marketing_attribution.view`, `crm.view`, and `crm.manage`;
only touches in their actionable active branches are returned. The Growth API's
normal app-availability gate also applies. No lead identifier, contact details,
CRM data or row existence is returned for another tenant or a non-authorized
branch. An empty result means no *visible* reports, not no interaction anywhere.
Offset pagination can shift if records are added while browsing. This is not a
unified customer timeline or visit-note/follow-up synchronization; those require
separate ownership, privacy and authorization work.

## Self-service reporting against an existing lead

A user with **all three** `marketing_assignments.self`, `crm.view` and `crm.manage` can report a touch from their own assignment queue. These CRM permissions are separately granted; the self capability never grants CRM search, team-wide assignment or attribution access. CRM lead search uses the existing CRM API and its existing tenant-wide visibility. The server rechecks the authenticated user's active employee-agent link, membership and active authorized branch, including on idempotent replays. New records also require a non-canceled assignment and active target and use the same converted-party consistency and atomic audit rules as manager reports. A retry of an existing record may succeed after cancellation or archival only while the user still owns it and has access. No lead or CRM activity is created or updated; this is a user-attested report, not verified visit, consent, attribution, sale or payment evidence. Hybrid site-level restrictions remain future work.

The form keeps a retry key only in memory for unchanged inputs. If a response is ambiguous, retry with the same selections before changing them or leaving the form; reload, closing the form or switching assignments loses that key and can result in a duplicate report. Lead search uses offset pagination, so concurrent changes can shift pages.


## My reported interactions

The assignment queue can show a read-only, searchable history of Growth reports the
employee personally created for assignments currently linked to their own active
employee-agent record, limited to actionable active branches. It requires the same
three explicit permissions as self-reporting. A manager's reports on the employee's
assignment and the employee's reports on someone else's assignment are not exposed
by this self-service list. Archived targets and canceled assignments remain visible
while ownership and access remain valid. Server recording time uses the branch's
Jalali timezone; labels (including lead names) are current, not snapshots. Pages use
an offset and may shift when reports are added.

History can help review recent submissions, but similar-looking rows do not prove
which request succeeded; it does not supply a durable retry key or exactly-once
semantics across refresh, and it must not be treated as proof of visits or consent.
The form retains the same in-memory retry behavior and limitations described above.
No CRM activity, lead, attribution, payout or other accounting record is created.
