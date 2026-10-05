# CRM architecture

How the CRM app is built, what it owns, and — more usefully — the rules it
follows and why each one exists. Most of these rules were written after
something went wrong; where that is the case, the failure is described, because
a rule whose reason has been forgotten is a rule that gets removed the first
time it is inconvenient.

## What the CRM owns

The CRM owns the **relationship** with a customer: who they are to us, what
we have promised them, what we are selling them, and what they have consented
to. It owns leads, deals and pipelines, activities and tasks, service cases,
segments, notes, consent records, and the reconciliation queue for online
shoppers.

It owns **no financial, campaign or website source of truth**. Those live in
Accounting, Growth and Website respectively, and the CRM reads them through
their services.

### `parties` is canonical

There is one identity record per person, in `parties`, shared by every app. A
customer, a supplier and a member of staff can be the same row with several
roles. The CRM does not have a `contacts` table and must never grow one: a
second identity table means one person split across two rows that can never be
reconciled, and every report thereafter has to guess which is real.

Leads are the one deliberate exception, and they are not an exception to the
rule so much as a statement of it — see below.

## The four hard rules

These are enforced by `src/lib/crm-app-boundaries.test.ts`, which reads the
CRM's own source. Two of the rules failed on their first run against existing
code, which is the argument for having them.

### 1. The CRM does not re-derive money

Every financial figure comes from Accounting, through
`src/lib/crm-accounting-contract.ts`. That module adds no arithmetic; it is a
typed, read-only facade.

A/R attribution is the reason. A receivable line names a customer through the
order, the receipt or the cheque that caused it, and closed-order corrections
arrive through `order_amendments` pointing back at the original order. Miss the
amendment bridge and a corrected invoice silently detaches from its customer. A
second implementation *will* miss something, and when the CRM says a customer
owes ۲٬۰۰۰٬۰۰۰ and the trial balance disagrees, nobody can tell which is lying —
and the CRM's number is the wrong one.

Accounting therefore exports the attribution SQL itself
(`AR_CUSTOMER_ATTRIBUTION_SQL`, `arBalanceByCustomerSql`). There are two
legitimate call shapes and neither can be expressed in terms of the other:

- one customer at a time, for a customer file;
- every customer at once as a CTE, for the segment engine — which joins A/R
  against tens of thousands of parties and cannot call a per-customer function
  without turning one query into an N+1 over the whole directory.

Both use the same fragment. Reusing Accounting's exported SQL is permitted;
hand-written ledger SQL in the CRM is not.

### 2. Winning a deal posts nothing

No CRM module writes to `orders`, `order_items`, `journal_entries`,
`journal_lines` or `ar_receipts`. Moving a deal to «برنده» writes no journal
line and issues no invoice.

Three reasons, in order of severity:

1. Dragging a card between two columns is a low-ceremony gesture performed by
   salespeople on phones. Issuing a financial document has tax consequences.
   Wiring the first to the second means the income statement can be moved by a
   mis-drag.
2. The real invoice is raised in Accounting regardless — that is where stock,
   pricing, tax and payment terms live. A deal that also posted would book the
   same sale twice.
3. A deal's value is a forecast. An invoice line needs a quantity, a unit
   price, a tax treatment and a catalogue item. Converting the first into the
   second invents four facts nobody supplied.

`src/lib/crm-deal-handoff.ts` is the bridge: it validates that a deal is ready,
deep-links into Accounting with the customer and deal pre-filled, and records
the resulting document against the deal afterwards. The CRM observes the sale;
it does not cause it.

### 3. Consent is never manufactured

Buying something is not permission to be marketed to. No import, sync or
conversion path writes `sms_consent` or `marketing_consent`. Only an explicit
consent action does, and it writes an audit row alongside.

This includes lead conversion: a lead has no consent columns to copy, by
design.

### 4. Identity is never guessed

No query resolves an ambiguous person with `ORDER BY created_at LIMIT 1`.

This one is written in blood. The WooCommerce sync used to answer every
identity question whether or not it could: two customers sharing a billing
phone — a family, a couple, one work number — and it attached the order to
whichever record was created first. Nothing failed. The purchase simply entered
the wrong person's history, their spend total, their RFM score, and every
segment and campaign derived from them.

`findIdentityCandidates` returns **all** matches. One match auto-links with a
recorded confidence; two or more park the profile as `needs_review` and the
order is imported unattributed until a human decides. A visible queue of five
unresolved shoppers is a far better state than five silently misattributed
ones.

The same rule governs lead conversion (below) and the duplicate-merge screen.

## Leads are not parties

A lead is an unqualified enquiry. Most never buy. If every enquiry became a
`parties` row, the directory would fill with non-customers, «چند مشتری داریم؟»
would stop meaning anything, and every purchase-behaviour segment would be
diluted.

So `crm_leads` is its own table, and a lead becomes a party exactly once, at
conversion, through `convertLead`. That function:

1. Locks the lead — inside a real transaction (see below).
2. Refuses if already converted. Idempotence at the data level, not at the
   button.
3. Runs the duplicate check.
4. Creates or links the party through `createParty`, so field encryption, blind
   indexes, phone normalisation and accounting codes all happen the one way
   they are meant to. Writing the INSERT by hand here is how a record ends up
   unsearchable by phone.
5. Optionally opens a deal in the default pipeline's first open stage.
6. Marks the lead converted, pointing at both halves.

**The duplicate check can refuse.** Zero matches converts. One match is offered
to the user as a question. Two or more **stops the conversion** — there is no
honest way for a server to choose, and `acknowledgeDuplicates` does not
override it. The user picks a specific `partyId` or fixes the duplicates first.

Converted leads are immutable: they have become a party, and editing the husk
they left behind would silently diverge from the record people actually use.

## Pipelines are rows, not an enum

Every business sells differently — a jeweller has «ارزیابی» and «سفارش ساخت»
where a café has neither. The enum version shipped first and the first question
anyone asked was how to rename a stage.

What makes renaming safe is that **reporting keys on each stage's `outcome`**
(`open` / `won` / `lost`), never on its name. Rename «برنده» and every
historical win rate still means the same thing.

Related decisions:

- `crm_deals.stage` (the legacy text column) is still written, kept in step by
  `legacyStageKey()`. Bookmarked URLs, cached browser bundles and external
  callers still send the old six-value key; rejecting them would break working
  integrations to gain nothing. Legacy keys resolve into the real pipeline, so
  those callers get stage history too.
- `savePipelineStages` is whole-list in one transaction, because ordering is a
  property of the set. It refuses to delete a stage holding deals (they would
  become invisible on every board and every forecast), and requires at least
  one `open` and one `won` stage (without them, deals cannot be created or
  closed and the win rate is structurally zero).
- `defaultPipeline()` **lazily seeds**. Migration 0157 only backfilled
  businesses that existed when it ran, and there are three separate
  provisioning paths. Self-healing on read is the only version that a fourth
  path cannot break.
- Velocity uses `percentile_cont(0.5)` — the median. Dwell times are
  long-tailed and one deal parked over Nowruz would drag a mean into
  meaninglessness.

## `withTenantTransaction`, and why `withTenant` is not enough

`withTenant` establishes the RLS scope. It is **not** a transaction. Each
`query()` inside it checks out its own pooled connection, so a sequence of
writes is a sequence of independent autocommits — and, critically,
`SELECT ... FOR UPDATE` releases its lock the instant that statement's
connection returns to the pool.

That makes a lock-then-check-then-write guard silently useless. Two
simultaneous requests both take the lock (sequentially, each on its own
connection), both see the pre-write state, and both proceed. This was a real,
demonstrated bug: a double-clicked convert button produced two customers, and
the same broken pattern existed in `mergeCustomers`, `resolveExternalProfile`
and several other places.

`withTenantTransaction` pins one client under `BEGIN`/`COMMIT` and redirects
`query()` to it, so every call site is fixed without changing its SQL.

Two consequences worth knowing:

- Statements issued on a pinned client are **chained**, because one pg client
  cannot run concurrent queries. `Promise.all` inside a transaction does not
  parallelise anything; it warns and, on some driver versions, interleaves
  results onto the wrong promises. Serialising is structural rather than a rule
  to remember.
- Use plain `withTenant` for reads and single writes — it does not hold a
  connection for the duration. Use `withTenantTransaction` for any multi-write
  invariant and for **any** `FOR UPDATE` or advisory lock.

## RFM freshness is a job, never a hook

RFM is a whole-population property: a customer is in the top recency quintile
only relative to everyone else. So "rescore because this person just bought
something" means scanning every customer and every order.

Doing that at checkout would put a full-table aggregation on the path of taking
money — the till waits for a report on a busy Friday — and, worse, a failure in
a *reporting* calculation would fail the *sale*.

So checkout calls `markScoringDirtyIn`: one upsert of one row, inside the
existing payment transaction, so a rolled-back sale rolls back the mark too.
`runCrmScoringTick` (every 15 minutes) does the scanning, with:

- a **debounce**, so a lunch rush is one scan rather than two hundred;
- a **daily floor**, because recency decays with the calendar and no order will
  ever arrive to signal it — a shop closed for Nowruz must not reopen to scores
  frozen at the moment it shut;
- **stale-claim reclamation**, so a worker killed mid-run does not freeze one
  tenant's scores forever.

Staleness is reported rather than hidden. Never-scored reads as a null age, not
zero — zero means "scored just now", which is the opposite of the truth. A
score presented as current when it is two days old is a lie the reader cannot
detect.

> One bug worth recording: the first version cleared the dirty flag by
> remembering `dirty_since` and comparing it for equality. Postgres keeps
> microseconds; a JS `Date` keeps milliseconds. The comparison never matched,
> so the flag would never have cleared and every business would have been
> rescored on every tick forever. It now compares against the run's start time.

## Case SLA pauses while waiting on the customer

A case's age is not the time since it opened. Some of that was spent waiting
for the customer to send their order number.

Counting that against the team causes three failures: reports say the team is
failing when it is not, so they get ignored; the fastest way to protect the
number becomes *not asking the customer anything*; and genuinely-neglected
cases are buried among false positives.

`waiting_seconds` accumulates every waiting stretch and is subtracted. It is a
**stored running total**, not derived at read time, because a case can bounce
between waiting and active a dozen times and a status column only knows where
the case is now. Closing out the stretch on every exit from `waiting` is what
stops a bouncing case silently improving its own SLA.

`first_response_at` is stamped once and never moved. "Somebody acknowledged me"
and "my problem is fixed" are different promises; collapsing them hides the case
that got a fast reply and then sat for two weeks. Closing an untouched case does
not count as a response.

`waitingOnCustomer` is reported as its own figure and never folded into
`breached`.

## Merge is irreversible, human-only, and registry-driven

Merging two customers rewrites every order, invoice, receipt and note that
pointed at the loser and archives it. It cannot be undone.

- It requires its own permission (`crm.merge`), separate from
  `crm.manage`. "Clean up the duplicates" is exactly the task a business
  delegates to its newest employee.
- It is absent from the AI assistant and autopilot surfaces, along with every
  other irreversible or judgement-bearing CRM action.
- The references it moves come from `src/lib/party-merge-references.ts`, a
  registry derived from FK metadata, not a hand-written list. The hand-written
  list fell one table behind every feature that linked something to a customer,
  and the symptom was silent.

## Custom fields are typed, and a type never changes

Every business wants a field nobody anticipated — «شمارهٔ قرارداد», «طبقه».
`crm_custom_fields` defines them and `crm_custom_field_values` stores each
answer in a **typed shadow column** (`value_number`, `value_date`,
`value_list`, …) chosen at write time by `coerceCustomValue`.

Typing on write rather than on read is what keeps a report from casting user
input: a bad value is a validation message on the form, not a 500 on a
dashboard three screens away.

Two rules follow from that:

- **A field's type cannot change once it holds values.** Reinterpreting a text
  answer of «حدود ۵۰۰ هزار» as money either discards what somebody wrote or
  invents a figure they never entered. Archive the field and make a new one.
- **Archive, never delete.** An answer recorded against a since-archived field
  is still a fact somebody entered, so `customValuesFor` deliberately does not
  filter archived definitions out.

Keys are ASCII-derived (`field_3` for a Persian label) because the key travels
through CSV headers, API payloads and segment definitions, where an RTL string
is a reliable encoding bug. The *label* is what people read.

## Relationships are a graph, not a second hierarchy

`crm_party_relationships` links parties to each other — contact of, billing
contact, household, referred by. It is an edge table over `parties`, not
another place a person can exist.

- An edge reads `from → to`: «علی مخاطب شرکت الف است». `relationshipsFor`
  UNIONs both directions and flags the reverse leg `inverse`, so each file
  shows the edge labelled from its own side.
- **Only `household` is symmetric** and gets a mirror row. `referred_by` is
  emphatically not: A referred B does not mean B referred A, and conflating
  them corrupts attribution.
- One primary per `(to_party, kind)`. Two "primary billing contacts" is not a
  state anybody can act on.
- **Merge re-pointing is not in this service.** Both directions of the table
  are declared in `party-merge-references.ts` with `selfEdgeColumn` and
  `uniqueWithSql`, so the generic merge drops would-be self-edges and
  collisions before re-pointing. A second copy here is exactly the
  hand-maintained list that registry replaced.

## Segment versions make a sent campaign explainable

Editing a segment's rules mints an immutable row in
`customer_segment_versions`. A rename does not — versions exist to answer «این
کمپین به چه کسانی رفت؟», which is a function of the rules, not the label.

## Automations act only on records that already exist

`crm_automations` stores a rule a business composed; `crm_automation_runs` is the
append-only record of every time one was considered. The vocabulary — three
triggers, four conditions declared per trigger, three actions — lives in
`crm-automation-rules.ts` and is **code, not rows**: a trigger nobody implements
would be a rule that silently never fires, and a condition whose query does not
exist would be a rule that silently fires always. The same file validates a rule
and is pure, so the API, the form and the tests agree by construction.

- **Rules fire after the write commits, never inside it.** The four write paths
  that own the events (`moveDealToStage`, `upsertDeal`, `upsertCase`, `saveLead`)
  call the engine once the row is theirs. A rule's failure must not roll back the
  salesperson's drag, and a failed statement inside a transaction would poison it
  for everything after — the same posture as `recordCrmAudit`.
- **A bulk import fires nothing.** The data-transfer engine writes its own rows
  (`data-transfer/entities/crm.ts`) rather than calling these services, so
  loading a thousand leads does not file a thousand follow-ups: an import is a
  load, not a decision.
- **A deal born on a stage has entered it**; a save that rewrites the stage the
  deal is already on is not a move and fires nothing. Creation is a real event
  for a rule that watches the first stage, and `dealStageMoved` is the single
  answer to what counts as one.
- **An action is a CRM write and nothing else.** A follow-up becomes a real
  `crm_activities` task (so it appears in the list, the queues and the customer's
  timeline); an assignment writes both owner columns from one `resolveOwner`
  resolution, and refuses a member who has been deactivated since the rule was
  written. A generated task whose member is gone falls back to the record's
  owner and then to «بدون مسئول» — never dropped, never handed to a departed
  colleague.
- **One action leaves the CRM, and it carries no message.** `notify_growth`
  writes a run row and an audit event; Growth (which already reads CRM scoring)
  consumes it and owns the campaign, the consent check and the outbox. The engine
  has no channel, no template and no recipient, and
  `crm-app-boundaries.test.ts` reads both the engine's SQL and every CRM file for
  the names of Growth's sending half.
- **A missing member or an unknown value is an error, not a default.**
  `automation_member_inactive` and `automation_condition_invalid` are refusals at
  the door; the stored row is the normalized document, with nulls for the config
  an action does not use.

It is not the AI automations engine (`ai_automations`, 0155): that one is
business-wide, gated on `ai_assistant`, gated on A/R / A/P / inventory facts, and
proposes actions from the AI catalog under an approval mode. A CRM rule is
per-record and deterministic, and must work for a business with no AI
entitlement. Merging them would mean either giving the CRM the catalog — and a
path to propose a send — or rebuilding a working engine's fact model.

The section is gated on `crm.configure`, like the pipeline and the business
fields, and lives off the rail (`CRM_SUB_SECTIONS`) reached from CRM settings and
the command field.

## Import and export

`analyseImport` parses, validates and matches every row and **writes nothing**;
`commitImport` performs it. The UI shows the analysis and asks. An import is
the fastest way to damage a directory, and there is no undo, so the
irreversible bulk write is turned into a decision somebody can actually make.

`commitImport` re-analyses server-side rather than trusting the approved plan —
it is minutes old, and another member may have created a matching customer
since.

Two non-negotiables:

- **Import never grants consent.** No consent column, no flag to enable one, a
  `sms_consent` column in the file is ignored, and the audit entry records
  `consentGranted: false`. Whoever assembled the list may sincerely believe
  those people opted in; the business's legal position depends on a consent
  record with a source and a timestamp.
- **Ambiguity is reported, never resolved.** A row matching two customers is
  skipped with both candidates named. Picking the older one is the
  misattribution bug arriving in bulk.

Export is behind `crm.export`, audited with row count and filters, excludes
consent state, and prefixes formula-looking cells with an apostrophe so Excel
does not execute a customer name of `=HYPERLINK(...)`.

Both halves share `crm-csv.ts` (BOM handling, quoted fields, Persian digits) —
pure and unit-tested, so an exported file re-imports as matches rather than
duplicates.

## Saved views

A saved view's `filters` document is validated against a **closed vocabulary
per entity** on write and on read. It is user-authored content that one
member creates and another member's browser executes — the shape of a stored
injection — so the worst a malicious view can do is filter on a field that does
not exist. Privacy (`owner_user_id` NULL = shared) is enforced in the SQL,
including in the `DELETE`, so there is no check-then-act race.

## Permissions

`src/lib/crm-permissions.ts` is the single source of truth: one row per section
naming who may read it, write it, reshape it, destroy it or merge it. Everything
else derives from it — the sidebar, the page gate, and the boolean props the
section components use to draw their controls.

The permission vocabulary is the six keys below plus `parties.view` /
`parties.manage`, which the floor's sections (directory, customer file,
activities, cases) genuinely need because their data belongs to the shared
parties service.

Two shapes worth knowing before editing the table:

- **`read` is a conjunction (`all`) plus alternatives (`anyOf`).** The
  alternatives exist for the management sections, which require the base read
  *and* a management capability — so `crm.export` can never substitute for
  `crm.view` while the cashier, who holds `crm.view` through `crm.manage`, is
  still kept off the forecast.
- **`screenOwned` and `routes` are declared exceptions.** `screenOwned` names
  actions a screen gates with its own prop (the directory's write controls, the
  case delete button); `routes` names a route whose requirement deliberately
  differs from its action's default (the relationships endpoints, which need
  `crm.manage` although they are written from the customer file). Both are
  read by `crm-permissions.test.ts`, which fails when a route and the table
  disagree in either direction.

CRM permissions split by **blast radius**, not by screen:

| Permission | What it protects |
|---|---|
| `crm.view` | Reading the 360° file, pipeline, segments, reports |
| `crm.manage` | Day-to-day work: notes, tasks, activities, cases, deals |
| `crm.merge` | The one irreversible action |
| `crm.consent_manage` | A legal record: who may lawfully be contacted |
| `crm.export` | Walking out with the customer list |
| `crm.configure` | Reshaping stages and segments every report is keyed to |

Bundling these into one `crm.manage` would mean granting a junior salesperson
the ability to destroy the directory in order to let them log a phone call.

Presets preserve existing access: manager keeps everything it could already
reach (introducing a permission must not silently remove access somebody had —
that is an outage, not a security improvement), and cashier gets `crm.manage`
only, matching what the nav already showed them.

## Testing

| Gate | Command |
|---|---|
| Types | `npx tsc --noEmit` |
| Unit | `npm test` |
| Database | `npm run test:db` (~8 min) |
| Design | `npm run test:design` |
| Build | `npm run build` |

`src/lib/crm-permissions.test.ts` reads every route under `src/app/api/crm/` and
compares it with `crm-permissions.ts` in both directions: whoever may open a
section must pass its routes, and whoever the table promises an action must not
be refused by the route that performs it. It also pins the admitted section set
per built-in role, so a tweak to the table cannot silently hand the floor the
pipeline.

The product shape — the six destinations, the smart queues, explainable health,
the handoff, and the seams deliberately left unbuilt — is in
`docs/crm-relationship-os.md`.

Boundary rules live in `src/lib/crm-app-boundaries.test.ts` and run in the unit
suite. They read source rather than behaviour on purpose: a future change that
"helpfully" rescores after a sale, or adds one more ledger query to the CRM,
would pass every behavioural test in the repository.
