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
| کیفیت داده | quality (duplicates, reconciliation inside it) | Can the directory be trusted? |
| تنظیمات | audit, settings | Who decided what, and how does this app behave? |

If a section is added to `CRM_NAV_ITEMS` but not to a group it disappears from
the menu silently, so `crm-nav.test.ts` pins coverage both ways.

`duplicates`, `reconciliation` and `automations` are **sub-sections** — real
sections with their own routes, gates and bookmarks, reached from the screen that
owns them (the data-quality workspace for the first two, CRM settings for the
rules) rather than from the rail (`CRM_SUB_SECTIONS` in `crm-nav.ts`). That is an information
decision, not a permission one, which is why it is a declared list: the same
tests that skip them for the rail also assert they are absent for *everyone*,
signed-in role or not.

## One box: search, or ask

`crm-command-field.tsx` sits in the app shell, under the header, on every CRM
screen. It answers a typed phrase with one of exactly three things:

| What was typed | What comes back |
|---|---|
| a destination — «تیکت‌ها» | that section |
| a problem — «معامله‌های راکد» | the queue's screen, scrolled to the queue's own card |
| anything else — «مریم احمدی» | the directory, opened at `?q=` |

The grammar is `src/lib/crm-commands.ts`: a **closed vocabulary** of section
keys and queue keys with the words people use for them, folded for the way
Persian is actually typed (ZWNJ, Arabic yeh/kaf, harakat, Persian digits, a
trailing «؟»). Nothing typed becomes a query — the interpreter returns keys and
hrefs the app already has — so the worst a wrong match can do is offer the wrong
*screen*, and the screen's own gate decides what is on it. That property is why
this shipped without a model: an LLM may later choose among the same keys, and
the interface would not change.

Permissions are applied where the answers are built, from `crm-permissions.ts`
— the same table the sidebar, the route guards and the API use. A member is
offered exactly the doors they may open; a cashier typing «فرصت‌ها» gets the
floor's own surfaces and no glimpse of the pipeline.

`Ctrl/⌘+K` focuses the field from anywhere, arrows move between answers, `Enter`
opens the highlighted one, `Escape` clears, and every answer is also a plain
link. Under the box the field prints what it understood («فهمیدم: …») before
anything opens, because a search box that guesses silently is one people stop
trusting.

## Today is a feed of work, not a dashboard

`src/lib/crm-queues.ts` is the attention feed. Thirteen named rules run over the
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

## The ring on a customer's file: connections as a picture, and as a list

`crm-relationship-graph.ts` turns one party's `relationshipsFor` rows into a
ring — this person in the middle, their connections around it, one spoke per
recorded fact — and `crm-relationship-ring.tsx` draws it above the list that
already showed the same rows.

Four decisions make it usable rather than decorative:

- **Ego network, not a hairball.** The whole business's graph would need a force
  layout, a viewport and a reason a shop's CRM does not have. «Who is connected
  to this person» is a picture of a list, and the list stays the authoritative
  copy — the ring is optional over authoritative content, which is why it can be
  small.
- **Deterministic.** Positions are a pure function of the service's order
  (`isPrimary` first, newest first) in a fixed 0–100 space, with no clock, no
  randomness and no layout engine: the same file draws the same picture on every
  visit. A graph that rearranges itself teaches people not to read it.
- **Read from *this* file's end.** An edge is directed (`from → to`) and the
  service flags the reverse leg `inverse`, so the ring's labels match the list's
  — «تصمیم‌گیرنده» on one file, «تصمیم‌گیرنده دارد» on the other.
- **Named in words.** The figure's accessible name is the caption
  (`relationshipGraphCaption`): the count and the kinds, in Persian, in the same
  vocabulary as the legend-free list. The picture is never the only copy of a
  fact.

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

The attention feed closes the loop: the **«کارهای عضو غیرفعال»** queue lists the
open deals and tickets whose owner can no longer sign in, and reassigning one
removes it. Reassignment itself is always manual — nothing moves a portfolio of
real customers because somebody's role changed.

`src/lib/crm-ownership.ts` is the write side: `resolveOwner` turns a member id
(verified to belong to this business — a foreign id is a leak, not an
assignment) or a typed name into `{ userId, name }`, and writes go through it, so
the id and the snapshot can never disagree. `GET /api/crm/members` is the
assignee picker's own read under `crm.view` — not `/api/team`, which needs a
team key the pipeline does not, and returns more than a picker needs. Inactive
members are **included**: reassignment starts by seeing who holds what.

Every screen that can assign now assigns a **member**:

| Surface | Control | Field it writes |
|---|---|---|
| معامله‌ها | `CrmAssigneePicker` in the deal dialog | `owner_user_id` + `owner_user` |
| کارها و پیگیری‌ها | the same picker in the task dialog, plus a **«کارهای من»** chip | `assignee_user_id` + `assigned_to` |
| تیکت‌های خدمات | the same picker, plus a **«تیکت‌های من»** chip | `assignee_user_id` + `assigned_to` |
| سرنخ‌ها | the same picker in the lead dialog — the «مسئول» column existed and had no way to be filled | `owner_user_id` + `owner_name` |

`src/app/(app)/crm/crm-assignee-picker.tsx` is that one control. It writes the id
and the name together (one decision, two columns), shows inactive members marked
rather than hiding them, and — the part that matters for old data — offers a
row's recorded name as its own option («نام ثبت‌شدهٔ قبلی») and keeps it
selected, so opening a pre-0157 row to fix a typo cannot silently erase who had
it. The *name* is still accepted by the API on the legacy `assignedTo` /
`ownerName` fields, because integrations write those: it goes through the same
`resolveOwner`, which resolves an unambiguous name and leaves anything else
unassigned with the name kept.

«کارهای من» and «تیکت‌های من» filter by **member id, from the session** — never
by a name, and never by a query parameter naming somebody else. Two colleagues
can share a name; a name filter would quietly hand one of them the other's work,
and a `?mine=<id>` would be a filter pretending to be a permission.

## The data-quality workspace

`/crm/quality` answers one question — *can this record be trusted?* — at three
levels, and they are views of one screen rather than three menu items because
they are decided by the same person with the same key and end in the same act:

| view | the question | backend |
|---|---|---|
| مسائل داده | is this record usable? | `crm-data-quality.ts` |
| اشخاص تکراری | are these two rows one person? | `crm-service.ts` (detector + merge) |
| تطبیق فروشگاه آنلاین | who is this anonymous shopper? | `crm-external-identity.ts` |

The issues feed has four rules, each one query that returns `count(*) OVER ()`
beside a `LIMIT`ed page — so the number and the list come from one statement and
can never describe different sets:

- **مشتری بدون راه تماس** — a customer with no phone and no email;
- **فرصت بی‌مشتری** — an open deal attached to nobody's history;
- **سرنخ بی‌تحرک** — a lead untouched for `STALE_LEAD_DAYS`;
- **کار بدون مسئول** — open work with neither a member nor a name.

Three rules this screen keeps, and one it refuses to keep:

1. **A real count, a capped preview.** Six unreachable customers report six and
   show five, and the card says «۱ مورد دیگر».
2. **Every row goes somewhere that fixes it** — the directory row, the deal, the
   lead, the ticket — never a dead end.
3. **Empty rules are not drawn.** A screen of zeroes teaches people to stop
   reading it; the count stays in the view's chip while it is real.
4. **No overall quality score.** A percentage is a number nobody can act on, and
   one that moves when unrelated things change teaches people to ignore it.

Nothing in the workspace writes. Merging two people stays a preview-then-confirm
act in the duplicate view, resolving an identity stays a human decision in the
reconciliation view, and fixing a gap is finished on the screen the gap points
at, under that screen's own permission. **No AI merges anything.**

## Automations: وقتی → اگر → آنگاه

`/crm/automations` is the last headline of the brief: a rule the business writes
itself, from three closed vocabularies, that files work or hands a record on
without anybody watching. It is reached from CRM settings and from the command
field rather than the rail (`CRM_SUB_SECTIONS`), because writing a rule is
configuration — but it is a section like any other: its own route, its own gate
(`crm.configure`) and its own bookmarks.

| part | what it may be |
|---|---|
| **وقتی** | a deal changing stage, a ticket being opened, a lead being created |
| **اگر** | value at least / source is / priority is / no owner — each declared only for the triggers whose records can satisfy it |
| **آنگاه** | file a follow-up task, assign a member, signal Growth |

Four properties make it safe to leave running, and each is a test rather than a
promise:

1. **The vocabulary is code, the rules are rows.** A trigger nobody implements
   would be a rule that silently never fires, and a condition whose query does
   not exist would be a rule that silently fires always — so a business composes
   what the product already has (`crm-automation-rules.ts`, pure and
   client-safe) and nothing a member types ever reaches SQL.
2. **Exactly one action leaves the CRM.** `notify_growth` writes a signal (a run
   row and an audit line) and nothing else: no channel, no template, no
   recipient, no audience. Growth owns campaigns, consent-checked sends and the
   outbox, and `crm-app-boundaries.test.ts` reads every CRM file for the names of
   Growth's messaging and fails if one appears. The engine's whole write surface
   is asserted to be eight statements over seven tables.
3. **A rule acts like a colleague, not like a robot with a quota.** A follow-up
   is a real `crm_activities` row — it lands in somebody's day, in the queues and
   on the customer's timeline. A member who has since been deactivated gets
   nobody's work: the task falls back to the record's owner, and to the «بدون
   مسئول» queue when there is none. A legacy owner written as a name counts as
   an owner, so a rule cannot reassign somebody's customer.
4. **Everything a rule does is recorded, including doing nothing.** Runs are
   append-only with the rule's name denormalised onto them, so deleting a rule
   leaves its history readable; a condition that did not hold is recorded as
   «اجرا نشد — شرط‌ها برقرار نبود», which is the question the screen exists to
   answer. The rule's counters only move for real effects.

Rules fire from the write paths that already own the events — `moveDealToStage`
(the kanban drag), `upsertDeal`, `upsertCase` and `saveLead` — **after** the
write commits, never inside its transaction: a rule's failure must not roll back
the salesperson's drag, and a failed statement inside a transaction would poison
it. A deal born on a stage counts as having entered it; a re-save of the stage a
deal is already on is not a move and fires nothing.

This is deliberately *not* the AI automations engine (`ai_automations`, 0155).
That one is business-wide, gated on the `ai_assistant` entitlement, gated on
facts like A/R and inventory, and proposes actions from the AI catalog under an
approval mode. A CRM rule is per-record, deterministic and available to a
business with no AI entitlement at all; folding the two together would mean
either giving the CRM the catalog — and with it a path to propose a send — or
rewriting a working engine's fact model. What is shared is the posture: closed
vocabulary, unknown values refused rather than ignored, append-only runs.

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
not exist. Automations record two kinds and only two: `automation.config_changed`
when a rule is written, switched or deleted, and `automation.signal_growth` when
the CRM asks Growth to look at a customer. The firings themselves are not copied
here — `crm_automation_runs` is the append-only record of those, and duplicating
every run would bury the judgements the log is for.

## Deliberately not built yet

These are named here so the seams are visible rather than implied:

- **An LLM narrator over the relationship summary.** The facts are already
  assembled with provenance (`crm-summary.ts`); what is missing is a model call
  and, more importantly, a rule that it may only compose from those lines.
- **An LLM in front of the command field.** The field itself shipped
  (`crm-commands.ts`, above) over the closed vocabularies — `CRM_QUEUE_KEYS`,
  the section keys, the saved-view filter documents per entity, the segment
  definition resolver. What is *not* built is the model that would let a
  free-form sentence choose among those keys: the interpreter still matches
  words. Whenever it arrives it may choose among the same keys and may not emit
  SQL, and `crm-app-boundaries.test.ts` keeps the assistant away from
  irreversible acts.
- **The saved-view filter vocabulary the command field will need** for «همهٔ
  مشتریان تهران که پارسال خریدند»: the resolver exists, the phrase vocabulary
  over its fields does not.
- **A list view of deals that honours the whole saved-view vocabulary.** The
  service stores seven filter keys for `deals` (`q, stageId, pipelineId, owner,
  open, minValue, maxValue`) and `listDeals` filters on a subset; the board has
  no filter controls at all. A view saved against `deals` through the API is
  therefore stored faithfully and applied partially — which is exactly the shape
  this document calls a lie. The leads list is the honest model: it declares its
  controls, hands them to `SavedViewsBar`, and applies back only what it has.
  Until the deals list exists, treat the extra keys as reserved.

Import and export are **not** on this list, and never appear as a CRM button:
the platform data-transfer engine owns that door, and the CRM's entities
(customers, companies, party categories, leads, deals, activities, pipeline
stages) are registered as adapters in `src/lib/data-transfer/entities/crm.ts`.
A pipeline screen that shipped its own CSV export would be a second exporter
with a second idea of what a customer row is.

Anything in this list that ships gets its rule written into
`docs/crm-architecture.md` first, as the existing rules were.
