# Reported marketer–lead touchpoints (issue #900, incremental)

Migration `0286` adds a Growth-owned, append-only report that links an **existing**
CRM lead to one existing assignment, its target, marketer and branch. An operator
chooses a contact channel and a value from the CRM source vocabulary. The server
records the creation time and actor; the channel and source are **user-attested**.
They are not proof that contact occurred, a GPS visit, consent, lead conversion,
last-touch acquisition source, sales attribution, a commission, or financial
compensation. It creates no CRM lead, CRM activity/timeline, report or accounting
entry and never changes a lead's source, a party's first/last source, or consent.
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
  canceled/completed assignment. If a lead is already converted and the target
  has a linked party, the parties must match. An unconverted lead can be linked;
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
consume lead deep links. Assignment options and lead results are paginated. This
slice does not implement team hierarchy, touchpoint self-service, CRM
conversion attribution and reporting, GPS/visit evidence, offline sync, online
tracking, rewards/settlement, analytics, or the remainder of issue #900.
