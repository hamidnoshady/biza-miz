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
All `withTenantScope` + `getSession`; ownership is the authorization.

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
| **AI projects (legacy)** | `/api/ai/projects/**` and `src/lib/ai-projects.ts` are untouched and still live. Both services write the same rows. |

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

## 7b. The access model (#761, migration 0192)

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

Still open from #761 and deliberately not in this change: server pagination
and totals, the Workspace shell / command bar / entity drawer, the redesigned
sections (Phases C–G of the issue).

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
