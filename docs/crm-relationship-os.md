# CRM as a Relationship OS

`docs/crm-architecture.md` states what the CRM *owns* and the four rules it may
never break. This file states what a member is supposed to be able to **do** with
it, and where each of those answers comes from in the code.

The reframe behind it: the CRM is not a set of record-keeping screens, it is the
place a business answers —

- who needs attention **today**, and why;
- what has actually happened with this customer;
- what to do next, and who owns it;
- which opportunities are moving and which are stuck;
- which customers are becoming more valuable, and which are drifting away.

Every screen below is one tap from those answers, and every number on them can be
traced to a row.

## The six destinations

The sidebar groups the twelve sections into the destinations, in
`src/app/(app)/crm/crm-nav.ts`:

| Destination | Sections | The question it answers |
|---|---|---|
| امروز | overview | Who needs attention? |
| مشتریان | directory, persons | Who is this person? |
| فرصت‌ها | deals, leads | What is moving, what is stuck? |
| ارتباط و پیگیری | activities, cases | What was promised, and what is owed back? |
| شناخت مشتری | segments, consent | Who are they as a group, and who may we contact? |
| کیفیت داده | duplicates, reconciliation | Can the directory be trusted? |
| تنظیمات | audit, settings | Who decided what, and how does this app behave? |

If a section is added to `CRM_NAV_ITEMS` but not to a group it disappears from
the menu silently, so `crm-nav.test.ts` pins coverage both ways.

## Today is a feed of work, not a dashboard

`src/lib/crm-queues.ts` is the attention feed. Twelve named rules run over the
tables that already own the facts — activities, cases, deals, parties, leads,
external profiles — and each one returns:

- a **real count** (`count(*) OVER ()` beside a `LIMIT`ed preview, so the total
  can never be the page size — the overview once reported a page length as a
  segment total);
- a one-sentence **why**, printed under the heading;
- rows that link straight into the screen that acts on them;
- one **action** line.

Design decisions worth keeping:

- **The vocabulary is a closed list in code.** Nothing a member types reaches a
  query, so "never generate raw SQL from AI" is a property of the module's shape
  rather than a policy it promises to follow.
- **A failing queue is dropped, never fatal.** Each rule is independently
  correct, and `crmQueues` logs and skips one that throws — the home page is not
  twelve features wide.
- **`sla_risk` is computed by `caseSla()`, not by SQL.** A second expression of
  the pause rule would drift from the ticket screen; the query only pre-filters
  by the *smallest* target so the JS pass stays bounded.
- **`possible_duplicates` counts with `phonePairKeySql`**, the same helper the
  duplicates screen uses — a count computed differently from the list it labels
  is the bug this file was written after.

Adding a queue: add the key to `CRM_QUEUE_KEYS`, add its rule and its
`queueKeysForSection` entry, and add a Persian label and why-line. The
integration test asserts the key list, the total-versus-preview property and the
section mapping.

## Customer health is explainable, or it is not shipped

`src/lib/crm-health.ts` answers «این مشتری حالش چطور است؟» with five states
(عالی / سالم / نیاز به توجه / در خطر / غیرفعال) **and the reasons**.

- The state is the *worst* cause; `reasons` lists every cause, worst first.
  There is no branch that can return a state with an empty explanation, and
  `crm-health.test.ts` asserts that over the whole input space.
- Silence is judged against the customer's **own** cadence («هر ۱۴ روز می‌خرید،
  ۴۰ روز گذشته»), with fixed bands only when there is no cadence yet.
- The lifecycle stage comes from `crm-scoring.ts` (the RFM job) — one scoring
  engine, never two.
- A past-due receivable is read through the accounting contract and its reason
  says so; the CRM does not recompute money.

The customer file shows the state as a badge and prints the reasons in a
«چرا؟» panel under the metrics.

## «این مشتری در یک نگاه» is written, not generated

`src/lib/crm-summary.ts` composes the summary from the three things the profile
screen has already fetched — the file, the notes and the merged timeline — and
every line carries the source it came from (خریدها، بخش‌بندی، وضعیت رابطه،
تاریخچه، رضایت ارتباط، حسابداری، کارهای باز). It runs no query of its own,
reads no clock, and cannot disagree with the metrics printed beside it.

That is deliberate. **A summary that can invent a fact about a person is worse
than no summary, because it is believed.** A narrator (an LLM, later) may
rephrase these lines, translate them, or choose what to lead with — it must not
be able to add a fact, which is why each line is data with a provenance rather
than a paragraph. `crm-summary.test.ts` pins determinism with the clock moved
between two calls, and pins that a customer with nothing on file still gets a
headline and a reason.

## The won-deal handoff

`src/lib/crm-deal-handoff.ts` + `deals/[id]/handoff`:

1. the dialog asks whether the deal is ready and shows **every** blocker at once
   (`no_customer`, `not_won`, `already_linked`, `customer_archived`);
2. «باز کردن فرم فروش» opens Accounting with the customer and deal pre-filled;
3. the document's id is pasted back and `linkDealToSalesDocument` links it —
   verifying the order belongs to this business, idempotent for the same order,
   refusing a different one, and auditing `createdByCrm: false`.

The CRM creates no order, invoice or journal line, and the integration test
asserts the business's `journal_entries` count is still zero after the whole
handoff has run.

## Pipelines are rows: the write path

- `stageId` is canonical; the legacy `stage` string is derived
  (`legacyStageKey`) and kept in step so reports keyed to it keep working.
- `upsertDeal` resolves the stage once, writes `stage_id`/`pipeline_id`, and
  restarts `stage_entered_at` only on a real change — that timestamp is what the
  stalled-deal queue reads.
- The board derives its columns from the pipeline (`GET /api/crm/deals`), keeps
  an inactive column while it still holds a deal, and falls back to the six
  seeded columns only when the pipeline could not be read.
- The configurator (`settings`) refuses, in the service and not the UI: an empty
  stage list, no open stage, no won stage, duplicate names, deleting a stage
  that still holds deals, and archiving the default pipeline or one with open
  deals. It sends usage counts alongside the list so the screen can explain the
  refusal *before* somebody presses save.

## Ownership is a member id; the name is a snapshot

**0157** added `owner_user_id` / `assignee_user_id` / `crm_owner_user_id` beside
the text columns and left the text columns in place as display snapshots — but
it did not fill the ids, so every "mine" view was unavailable to a business that
already had data. **0199** backfills them, under two rules:

1. **Only an unambiguous match is written.** A legacy name matching two members
   stays unassigned, and the row keeps the typed name (`owner_user`,
   `owner_name`, `assigned_to`) as its snapshot — a wrong owner is worse than an
   unassigned one, and the unassigned queue is where a human decides.
2. **Nothing is deleted or rewritten.** The migration only ever fills NULL ids,
   and is idempotent.

`src/lib/crm-ownership.ts` is the write side: `resolveOwner` turns a member id
(verified to belong to this business — a foreign id is a leak, not an
assignment) or a typed name into `{ userId, name }`, and writes go through it, so
the id and the snapshot can never disagree. `GET /api/crm/members` is the
assignee picker's own read under `crm.view` — not `/api/team`, which needs a
team key the pipeline does not, and returns more than a picker needs. Inactive
members are **included**: reassignment starts by seeing who holds what.

Activities and cases accept the same resolution on their existing `assignedTo`
field, so a typed name that matches exactly one member starts producing ids
before their dialogs grow pickers.

## Permissions: one table, checked against the routes

`src/lib/crm-permissions.ts` is the single source for section read / write /
configure / delete / merge, and `src/lib/crm-permissions.test.ts` reads every
route under `src/app/api/crm/` and compares it with that table in **both**
directions:

- whoever may open a section must pass its routes (the old bug: an OR-list let a
  member open Deals and then 403 on every request behind it);
- whoever the table promises an action must not be refused by the route that
  performs it (the old bug: the case delete button was drawn on `crm.manage`
  while the endpoint required `crm.delete`).

A route whose requirement deliberately differs from its section action's default
is listed in the section's `routes` refinement — declared, never inferred. An
action a section does not declare is **closed**, not open.

## The decision log

`listCrmAuditEvents` is read-only and append-only, with a closed vocabulary
(`CRM_AUDIT_KIND_LABELS` in `crm-shared.ts`, so a client component can render it
without reaching a server-only service). Shaping a pipeline records
`pipeline.created` / `pipeline.updated` / `pipeline.stages_changed` under entity
type `pipeline` — it used to be filed as a deal stage change of a deal that did
not exist.

## Deliberately not built yet

These are named here so the seams are visible rather than implied:

- **An LLM narrator over the relationship summary.** The facts are already
  assembled with provenance (`crm-summary.ts`); what is missing is a model call
  and, more importantly, a rule that it may only compose from those lines.
- **Natural-language command field.** The closed vocabularies it must translate
  into already exist — `CRM_QUEUE_KEYS` (queues), the saved-view filter
  documents per entity, and the segment definition resolver. A translation layer
  may choose *among* those keys; it may not emit SQL, and
  `crm-app-boundaries.test.ts` keeps the assistant away from irreversible acts.
- **Automations (When → If → Then)** and the **data-quality workspace** that
  groups duplicates, reconciliation and issues into one queue.
- **Import/export through the platform data-transfer engine** — the CRM entities
  are registered there; no CRM-specific exporter is added.

Anything in this list that ships gets its rule written into
`docs/crm-architecture.md` first, as the existing rules were.
