# Phase G — «میز کار من» (My Workspace)

> Status: implemented. This document is the development plan that was written
> **before** the code, kept as the phase record.

## 1. What «پروژه» is today (the audit)

Everything below already exists and **must keep working unchanged**.

### Data (migrations)

| Migration | What it added |
|---|---|
| `0111_ai_projects.sql` | `ai_projects` (id, business_id, name, instructions, created_by, archived_at, created_at), `ai_project_notes`, and `ai_conversations.project_id` |
| `0143_messaging_completion.sql` | `ai_projects.status` (`active`/`paused`/`completed`), `owner_user_id`, `budget_rial`, `updated_at`; `journal_entries.project_id` (the cost-centre dimension) |
| `0158_ai_project_memory.sql` | `ai_project_memory` — standing facts fed to the assistant |
| `0159_ai_project_tasks.sql` | `ai_project_tasks` — title + `open`/`done` only |
| `0160_ai_project_default_agent.sql` | `ai_projects.default_agent_id` — a pinned custom agent |
| `0161_media_asset_provenance.sql` | `media_assets.project_id` — a project's files |
| `0162_automation_coworker_project.sql` | `ai_automations.project_id`, `ai_coworker_jobs.project_id` |

Child tables carry **no `business_id`**: they reach tenant scope through their
parent `ai_projects` row (the `ai_messages`→`ai_conversations` shape).

### Services

- `src/lib/ai-projects-shared.ts` — pure limits (`PROJECT_INSTRUCTION_CHAR_LIMIT`, …)
- `src/lib/ai-projects.ts` — CRUD for project / notes / memory / tasks, the
  cost summary over `journal_entries.project_id`, and
  `getProjectPromptContext` + `buildProjectPromptContext`, which is what puts a
  project's instruction, notes, memory and open tasks into every chat turn
  inside that project.

### API

`/api/ai/projects`, `/api/ai/projects/[id]`, `…/notes`, `…/notes/[noteId]`,
`…/memory`, `…/memory/[memoryId]`, `…/tasks`, `…/tasks/[taskId]`, `…/files`.
Originally `withTenantScope` + `getSession` with ownership as the authorization;
since issue #907 F01 every route in the family also takes `workspaceOwner`
(`workspace.view` to read, `workspace.manage` to write) and the project role via
`requireProjectCapability`/`requireTaskWork`, and the two task writes run the
workspace commands (`updateWorkspaceTask`, `deleteWorkspaceTask`) instead of the
legacy service's own bypass.

### UI

`src/app/(app)/projects/page.tsx` (card grid + archive) and
`src/app/(app)/projects/[id]/page.tsx` (instructions, conversations, notes,
memory, tasks, files, operations panel). Reached from the workspace rail
(`dashboard-sidebar.tsx`) and listed in `PLATFORM_ROUTES` / `KNOWLEDGE_SECTIONS`.

### Integrations already present

- **AI** — project context in the system prompt; the two project-scoped
  actions `project.memory.add` / `project.task.add`; a pinned default agent.
- **Accounting** — `journal_entries.project_id` and the project-cost report.
- **Growth** — `message_campaigns.project_id`.
- **Media** — `media_assets.project_id`.
- **Automation** — `ai_automations.project_id`, `ai_coworker_jobs.project_id`.

### What it is missing

No customer/contract relation, no team, no document lifecycle, no approvals, no
calendar, no templates, tasks with two states and nothing else, and no
dashboard that answers "what needs my attention today".

## 2. Architecture decisions

1. **My Workspace is a platform module, not a fifth app.** `src/lib/apps.ts`
   stays at four apps (`accounting`, `growth`, `crm`, `website`). The workspace
   is a platform area with a section rail — exactly the shape `/settings`
   already has (`SectionNav variant="rail"`), so no new navigation concept and
   no new `AppKey`.
2. **Canonical route `/workspace`.** Per the canonical-route rule in
   `AGENTS.md`, the old `page.tsx` files move out of `/projects` and the old
   addresses survive only through the central redirect table in
   `src/lib/app-routes.ts` (`/projects/*` → `/workspace/projects/*`,
   `/dashboard/projects/*` → the same).
3. **Extend, never duplicate.** `ai_projects` and `ai_project_tasks` gain
   columns; nothing is renamed, no table is copied. Every existing column keeps
   its meaning, so every existing row keeps working with no data migration.
4. **One reusable entity per concept.** `workspace_members`,
   `workspace_project_phases`, `workspace_project_templates`,
   `workspace_contracts`, `workspace_documents`, `workspace_approvals`,
   `workspace_events`, `workspace_comments`, `workspace_task_checklist`,
   `workspace_task_dependencies`, `workspace_activity`. Comments are polymorphic
   (`subject_type`/`subject_id`) rather than one table per parent.
5. **Documents point at the Media Library**, they do not re-implement storage:
   `workspace_documents.media_asset_id → media_assets`.
6. **Two permission layers.** The platform's own `permissions.ts` gates the
   *area* (`workspace.view`, `workspace.manage`, `workspace.contracts_manage`,
   `workspace.approve`); `workspace_members.role`
   (owner/manager/editor/contributor/viewer) gates a *project*. No second
   permission system.
7. **Contracts are split by responsibility.** CRM keeps relationship contracts
   (customer/sales/service/partnership) on the customer file; the workspace owns
   *execution* contracts (contractor, supplier, consultant, subcontractor,
   vendor, developer) and every one of them may name a project.
8. **Templates live in code as a catalogue** (`workspace-shared.ts`) so no
   tenant needs seeding, and `workspace_project_templates` stores only a
   business's own custom templates.
9. **Dates**: Gregorian in the database (`date`/`timestamptz`), Shamsi on every
   screen through `formatJalali` / `JalaliDatePicker`. No `<input type="date">`.
10. **Design**: compose `PageShell`/`PageHeader`/`SectionCard`/`KpiCard`/
    `DataTable`/`FilterChip`/`StatusBadge`/`EmptyState` only — the Accounting
    reference language. No new UI primitive.

## 3. Sections

`overview`, `projects`, `tasks`, `calendar`, `documents`, `contracts`, `teams`,
`approvals`, `reports`, `templates`.

## 3b. Route map

| Path | Renders |
| --- | --- |
| `/workspace` | Overview (rendered, not a redirect) |
| `/workspace/[section]` | The other nine sections; an unknown section falls back to Overview |
| `/workspace/projects` | Project list |
| `/workspace/projects/[id]` | One project: header, phases, and the sections scoped to it |

`/projects`, `/projects/[id]` and `/dashboard/projects` answer **308** to the
matching `/workspace/...` path via `legacyRedirectTarget`, so every bookmark,
deep link and saved AI citation from before the rename still resolves.
`src/app/(app)/projects/` no longer exists.

## 4. Migration

`migrations/0167_my_workspace.sql` — additive only:

- `ai_projects`: `description`, `priority`, `project_type`, `template_key`,
  `start_date`, `end_date`, `tags`, `party_id`; the `status` CHECK is widened to
  add `planning` and `cancelled` while keeping `active`/`paused`/`completed`.
- `ai_project_tasks`: `description`, `assignee_user_id`, `priority`, `due_date`,
  `party_id`, `phase_id`, `position`; the `status` CHECK is widened to add
  `in_progress` and `blocked` while keeping `open`/`done` (so every existing
  row and every existing writer stays valid).
- Eleven new tenant tables, each with `business_id`, indexes and an RLS policy
  in the same migration.

Two migrations after 0167 change how the module behaves, both forward only:

`migrations/0258_workspace_approval_integrity.sql` (issue #907 F03):

- reconciles pre-existing duplicate `pending` requests: on a subject that
  already carries several, the **newest** stays pending and every older one
  becomes `cancelled` with a Persian note saying why (nothing is deleted and no
  decision is invented);
- then adds `uq_workspace_approvals_one_pending`, a partial unique index on
  `(business_id, subject_type, subject_id) WHERE status = 'pending'`. One live
  request per subject and revision is now a database fact rather than a
  read-then-write check two clients can interleave — `subject_id` already names
  the exact revision for the revision-bound AEC subjects, so no second column is
  invented. A duplicate insert surfaces as 23505 and the command layer maps it to
  `approval_already_pending`.

`migrations/0259_workspace_document_revision_chain.sql` (issue #907 F15): a
`BEFORE INSERT` trigger on `workspace_documents` that refuses a second successor
for the same `supersedes_id` (one revision chain per version, 23505 →
`document_already_superseded`). A trigger rather than a unique index because the
index could not be created over forks that already exist, and the only ways to
make existing data fit would rewrite history — which the issue forbids.

## 5. What the module now does (new features)

Ten sections, all built on the existing primitives and reachable from the
sidebar rail entry «میز کار من».

- **Overview** — the six figures the brief asked for (active projects, tasks
  today, my open tasks, pending approvals, upcoming deadlines, overdue tasks,
  expiring contracts), plus my tasks, the next deadlines, approvals waiting on
  me, and a recent-activity feed. Every figure is counted from the rows that
  own the fact, never from a stored counter that can drift.
- **Projects** — name, description, status (planning/active/paused/completed/
  cancelled), priority, owner, team, start/end date, tags, budget, and a link
  to a CRM party. A project detail page carries phases, members, activity and
  the per-project view of every other section.
- **Templates** — seven built-in phase templates (generic, construction,
  architecture, software, marketing, event, consulting) defined in code, plus
  per-business templates that can override a built-in by key or be archived.
  Creating a project from a template seeds its phases and starter tasks. None
  of it is restaurant-specific.
- **Tasks** — title, description, assignee, project, phase, customer, priority,
  status (open/in_progress/blocked/done), due date, checklist with rollup,
  comments, attachments, dependencies with a cycle guard, and activity history.
  One query serves the List, Kanban and Calendar views.
- **Contracts** — execution contracts only (contractor, supplier, consultant,
  subcontractor, vendor): title, type, project, counterparty, value in integer
  Rial, start and expiry date, status, documents, approval state and a
  reminder window (default 30 days).
- **Documents** — one table for documents belonging to a project, task,
  contract, customer or accounting entry. Files are `media_assets` rows, so
  upload, preview and permissions are the media library's, not a second
  implementation. Versions chain through `supersedes_id`; the default list
  shows current versions only.
- **Calendar** — one view unioning five sources: workspace events, project
  deadlines, task due dates, contract expiries and approval due dates.
- **Teams** — five project roles (owner, manager, editor, contributor, viewer)
  with a capability ladder, and a guard that refuses to remove the last owner.
- **Approvals** — a request/decide gate over a project, task, document or
  contract. Deciding an approval moves the subject (a contract goes
  draft → pending_approval → active); deciding twice returns null rather than
  double-applying. Subject titles are resolved live, never copied.
- **Reports** — per-project budget against actual spend, where spend is summed
  from `journal_lines` through `journal_entries.project_id`. The ledger is the
  only source of the spend figure.

### AI assistant

Four read tools — `get_workspace_project_status`, `list_workspace_tasks`,
`list_expiring_contracts`, `list_workspace_approvals` — registered at six
sites: the tool list, the executor, the agent runner, the custom-agent label
map, the dashboard-mode prompt, and the MCP catalogue. "Give me project status"
and "which contracts expire next month?" are answered from the workspace and
the CRM together. `mine: true` always resolves from the signed-in member, never
from a name in the prompt, and an ambiguous project name comes back as a
candidate list instead of a guess.

## 6. Integration points

| Module | How it connects |
| --- | --- |
| **CRM** | `ai_projects.party_id`, `workspace_contracts.party_id`, `ai_project_tasks.party_id`, `workspace_documents.party_id` all point at `parties`. All four are registered in `PARTY_REFERENCES` as `move`, so a customer merge re-points them at the surviving record. |
| **Accounting** | `journal_entries.project_id` (pre-existing) is the spend side of `projectReport`. Documents can hang off a journal entry. |
| **Media library** | `workspace_documents.media_asset_id` → `media_assets`. No parallel file store. |
| **Permissions** | Two layers: the platform keys `workspace.{view,manage,contracts_manage,approve}` intersected with the member's `workspace_members.role`. No separate permission system. |
| **Tenant export** | The eleven new tables carry `business_id` and are picked up automatically by `tenantTablesInDependencyOrder()`. |
| **Knowledge base** | The `projects` key is retained (it is stored in tenant rows) with the new label and `/workspace` route. |
| **MCP** | The four tools appear in the connector catalogue with English summaries; the connection's authorizing user supplies "mine". |
| **AI projects (legacy)** | `/api/ai/projects/**` and `src/lib/ai-projects.ts` still live and are still the assistant's project surface; both services write the same rows. Since issue #907 F01 the API routes share the workspace guard and the project role, and task state changes go through the workspace commands. |

## 7. Remaining limitations

Stated plainly, because each is a decision rather than an oversight:

1. **No fifth app shell.** My Workspace is a platform module under `/workspace`,
   not a fifth entry in `APP_KEYS`. Three guard tests assert the four-app shape
   (`app-availability.test.ts`, `apps.ts`, `workspace-rail-ai-launcher.test.ts`),
   and the brief called it a core module rather than a standalone app. The
   consequence: no per-app availability switch for Workspace.
2. **Inventory and Website integration are read-only today.** A project can
   reference materials and website tasks through documents and tasks, but there
   is no `project_id` on stock movements or website jobs. Adding it is another
   additive migration on those tables, not a change here.
3. **Kanban reordering is per-column.** `position` is stored and respected, but
   drag-and-drop across columns sets status and appends; it does not preserve a
   hand-ordered index across a status change.
4. **Document preview is the media library's.** Whatever the media layer can
   preview, Workspace can preview. There is no Workspace-specific renderer.
5. **Approvals are single-step.** One requester, one approver, one decision
   (approve / reject / request changes, or the requester withdraws).
   Multi-stage chains and quorum rules are not modelled.
6. **Contract reminders are computed, not pushed.** `contractNeedsReminder` and
   the expiry window drive the UI and the AI tool; nothing yet writes into the
   notification or messaging queue on its own schedule.

## 7a. Approval and lifecycle integrity (#907 F02, F03)

The approval engine owns the states it produces. `pending_approval` and `active`
on a contract, `in_review` and `approved` on a document, are written by
`requestApproval` and by the decision that lands on it — never by a form:

- **Forms offer only what a command does not own.** `CONTRACT_FORM_STATUSES` is
  `draft | expired | terminated | completed`; `DOCUMENT_FORM_STATUSES` is
  `draft | rejected | archived`. `expired`/`terminated`/`completed` stay writable
  on purpose: they are factual corrections an editor makes while reconciling a
  paper register, and the contract's own page renders a workflow-owned state as a
  read-only badge.
- **Both ends of a change are guarded.** `contractStatusChangeError` /
  `documentStatusChangeError` refuse entering *and* leaving a workflow state
  through an ordinary edit (`contract_status_requires_workflow`,
  `document_status_requires_workflow`, both 409). A no-op re-send is allowed, so
  an edit that does not touch the status never trips over the gate.
- **One live request per subject.** A retry by the same requester answers with
  the existing row (idempotent); anybody else gets `approval_already_pending`.
  `APPROVAL_REQUESTABLE_FROM` is `draft` for both subjects, so asking to approve
  something already active is `subject_not_requestable`.
- **Withdrawal reverts the subject.** Cancelling the last pending request returns
  `pending_approval`/`in_review` to `draft` inside the same transaction as the
  decision (`revertSubjectAfterWithdrawal`), which removes the orphan state the
  audit found on the live deployment (`pending_approval` with an empty inbox). A
  subject that still has another pending request is never moved.
- **Automations are held to the same rules.** The autopilot executors pass their
  payload straight through to the same commands, so an automation that proposes
  `status: "active"` fails with the same code rather than silently writing it or
  having the field quietly dropped.

Rows written before these fixes are repaired through the explicit, audited path
rather than an ordinary edit (which by design can neither enter nor leave a
workflow state): `npm run workspace:approvals` reports stranded subjects and
duplicate live requests, and `-- --apply` performs only those two repairs,
writing a `workspace_activity` row per subject it moves. It never approves,
activates or deletes anything, and it re-checks each row as it writes, so a
decision that landed after the report is respected rather than overridden. The
rules live in `src/lib/workspace-approval-report.ts`; the integration suite
exercises both halves against a disposable database. Operator steps:
`docs/runbooks/workspace-approval-reconciliation.md`.

## 7b. The access model (#761, migration 0194)

**effective capability = platform permission AND project role.** One layer in
`src/lib/workspace.ts` decides it, and every route, list, the dashboard, the
calendar, reports, lookups and the AI read tools go through it:

- `workspaceAccessFlags(permissions)` (pure, `workspace-shared.ts`) turns the
  member's *current* effective permissions into flags. The only way past
  membership is explicit: **`workspace.admin`** (preset: manager, admin; the
  owner holds everything) acts as a manager on every project, and
  **`ledger.view`** reads every project as a viewer, because projects are the
  cost centres the books post against. `workspace.view`/`workspace.manage`
  are never an override — the old `privileged = true` bypass is gone.
- `requireProjectCapability` / `resolveProjectRole` answer one project; a
  non-member gets `project_not_found`, never a 403 that confirms the project
  exists. `visibilityClause` is the SQL twin every list uses.
- `resolveWorkspaceSubject(type, id, capability)` resolves a polymorphic
  subject (comments, approvals, document links) from the subject itself —
  existence, tenant, project — so a caller cannot pair an id with the wrong
  project or write an orphan thread.
- **Business-level records** (a contract, document or event with no project)
  are visible to their author and to override holders; project-less
  contracts also to `workspace.contracts_manage` holders.
- **Approvals:** the subject's project is the approval's project (a
  mismatched `projectId` is refused); a named approver is the only decider
  (or an administrator); the requester never decides their own request
  (`approvalDecisionError`, pure and unit-tested). Withdrawing your own
  request runs on `workspace.manage`; every decision needs `workspace.approve`.
- **Contributors** work (status, position, checklist) only tasks assigned to
  them (`requireTaskWork`); re-scoping is `edit`.
- **Spend** in reports and the assistant is null — not 0 — without `ledger.view`.
- **Ownership:** a trigger on `ai_projects` keeps the owner's member row in
  step with `owner_user_id` on every write path (the legacy assistant path and
  the importer included), promoting the new owner and demoting the previous
  one to manager in the same statement. The named owner cannot be demoted or
  removed without a transfer; the last owner never.
- **Integrity:** a task's phase is in its project; a document's task, contract,
  media asset and journal entry are validated as one record against the final
  values; an event follows its task's project; partial date PATCHes are checked
  against the resulting record (also enforced by `NOT VALID` CHECKs for new
  writes). Template application is a duplicate-safe merge.
- The project page renders controls from the server's `capabilities` object.

## 7c. Shared interaction rules (#761 §20, §23, §24)

The later #761 phases added server pagination and filter-aware totals
(`usePagedList`), the command bar and Ctrl/Cmd+K palette, the entity drawer,
and the redesigned sections. The cleanup phase fixed three rules in one place
each, so a new section inherits them instead of re-deriving them:

- **One form dialog.** Every create/edit/decide form is `WorkspaceFormDialog`
  (`workspace-ui.tsx`), the platform's Radix `Dialog`: labelled, focus-trapped,
  Escape closes it, focus returns to whatever opened it (a button or a table
  row), and a stray click outside does not discard a half-filled form. The
  seven hand-rolled `fixed inset-0` overlays it replaced had none of that.
- **A clickable row is a button.** `DataTableRow` with `onClick` opens on
  Enter/Space and ignores clicks on a link or control inside it, so an action
  cell never also opens the row — no per-cell `stopPropagation`.
- **Tables become cards on a phone.** `stackedTableClass` on a `DataTable`
  turns each row into a card below `sm` — the first cell is the title, the rest
  read «label — value» from each cell's `data-label`. Desktop is unchanged; the
  role-permission matrix is a real grid and keeps scrolling.

## 7d. Project cost, and why the chain cannot fork (#907 F04, F15, F16)

**F04 — one definition of project cost.** `src/lib/project-costs.ts` holds the
policy as a paired subquery (`projectCostSubquerySql`,
`projectRevenueSubquerySql`) and the report, the AEC BOQ cockpit and the
assistant's cost report all use it:

- **expense accounts only** — a receivable, bank or revenue line is not a cost,
  and a capitalized amount is not one until it is expensed;
- **net, `debit - credit`** — a reversal is a real posted entry that credits the
  account it debited, so netting is what makes an undone expense stop counting;
- **reversals are attributed through `reverses_entry_id`** — the A/P and
  manual-journal reversal writers do not copy `project_id` onto the reversal
  row, so the rule lives in the query instead of in every writer's memory;
- **posted only** — every `journal_entries` row is posted in this schema
  (drafts live in `journal_entry_drafts`, 0029), so there is no status column
  to filter and a filter would be a lie about the model.

Budget − cost is a **budget variance**. It is not profit: the report shows no
revenue and its title/description/caption no longer say «سودآوری». Recognising
project revenue (and deciding what is capitalized first) is an Accounting
decision that has not been taken — see §9.

**F15 — the dependency graph and the revision chain are serialized.**
`addDependency` takes the project row's lock (`FOR UPDATE` on `ai_projects`)
before reading the project's edges, so two simultaneous opposite edges cannot
both pass the cycle walk; a deterministic reproduction (an uncommitted A→B edge
held by another session, with B→A issued meanwhile) is in
`integration/workspace.integration.test.ts`. `createDocument` locks the
predecessor row and refuses a second revision of the same version
(`document_already_superseded`), and migration
`0259_workspace_document_revision_chain.sql` makes the rule a database fact with
a `BEFORE INSERT` trigger (one successor per row). The trigger is forward-only
on purpose: a unique index would have required rewriting the forks that already
exist, which #907 forbids.

**F16 — a wrong type is a field error.** `trimTo` no longer trusts its type
(`invalid_text_field`, 400), `isIsoCalendarDate` checks that the day exists
rather than that the string is shaped like a day (`2026-02-31` is now
`invalid_date`, not a Postgres error), `reminderDays` is bounded to the 365 the
column's CHECK allows (`invalid_reminder_days`) with the constraint still the
backstop, and `readBody` treats a JSON array or primitive as "no body" instead
of casting it to a record.

## 8. Testing

Gates, all green:

- `npx tsc --noEmit` — clean.
- `npm test` — 374 files, 5337 tests.
- `npm run test:db` — 130 files, 1448 tests, including the new
  `integration/workspace.integration.test.ts` (21 cases).
- `npm run test:design` — 36 tests.
- `npm run build` — all `/workspace*` routes in the manifest, `/api/ai/projects/**`
  still present.

Verified by hand against a running dev server and a seeded tenant: all ten
sections plus the project detail page return 200; `dir="rtl"`, `lang="fa"`;
dates render Shamsi with Persian digits (`۳۱ شهریور ۱۴۰۵`) and no Gregorian
leakage; the calendar unions all five sources in date order; the legacy
`/projects` paths 308 to their `/workspace` equivalents.

## 9. Genuine remaining issues (#907)

Stated here so they are not mistaken for fixed:

1. **Project revenue / capitalisation (#907 F04).** `projectRevenueSubquerySql`
   exists and uses the same attribution as cost, but nothing user-facing calls
   it: recognising revenue (and deciding what is capitalized before it is) is an
   Accounting decision, not a workspace one. Until then the report shows cost and
   budget variance and says so, and shows no "profit".
2. **Reversal writers and `project_id` (part of F04).** The canonical cost query
   compensates for reversals that do not carry `project_id` by following
   `reverses_entry_id`. The cleaner fix is for every reversal writer to copy the
   original's dimension; that is an Accounting change and was left out of this
   PR on purpose.
3. **AEC subjects and cancellation.** Cancelling an AEC approval (variation,
   certificate, material request, commitment, submittal) does not revert that
   register's own status — the register owns its chain and reverts through its
   own actions. Reaching that from a withdrawal is a follow-up, not a workspace
   edit (`docs/runbooks/workspace-approval-reconciliation.md` §4).
4. **`readBody` is still untyped at the route level.** The hardening is at the
   service boundary, which is where the type was actually assumed. Typing every
   route body against a schema is a larger refactor that the audit did not ask
   for and that would touch thirty route files.

### Bugs this testing found and fixed

The suites were worth writing — they caught seven real defects, five of which
would have reached a user:

1. **Dates were served as `"Sun Mar 01"`.** `String(pgDate).slice(0, 10)` takes
   the first ten characters of a JS `Date`'s `toString()`. It type-checks, and
   it broke every date field in the module. Fixed with a single `isoDate()`
   helper over `postgresDateToIso`; pinned by a test that asserts the shape.
2. **A customer merge orphaned four workspace columns.** The merge registry
   modelled only `business_id` and `location_id` tenancy; `ai_project_tasks`
   has neither and reaches the tenant through its project. The generated SQL
   named a column that does not exist, aborting the whole merge transaction. A
   third `parent` scope was added and all four columns declared as `move`.
3. **The version chain used two recursive terms in one CTE**, which Postgres
   rejects outright — `listDocumentVersions` could never have run. Split into
   `ancestors` and `descendants`.
4. **`projectRoleFor` locked users out of their own projects.** 0167 backfills
   an owner row for projects that existed at migration time, but the legacy
   write path still creates projects without one, so anything created from the
   assistant after the migration was unreachable by its creator. (Since #761 a
   trigger writes that row on every path; see §7b.)
5. **The agent-builder label import dragged `pg` into the browser bundle**,
   failing the production build on `Can't resolve 'tls'`. Tool names and labels
   moved to the pure `workspace-shared` module.
6. The dashboard's "today" was UTC, so between midnight and 03:30 Tehran it
   counted the wrong day's tasks.
7. `setChecklistItem` was being called with an object where a boolean belongs.
