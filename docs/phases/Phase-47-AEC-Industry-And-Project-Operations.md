# Phase 47 — The AEC industry and AEC project operations

**Status:** Waves 1–9 implemented (migrations 0193–0201); Wave 10's report set, recommended widgets
and §26 classification implemented; the rest of Waves 10–11 designed here, not built.

Working issue: [#799 — Add Architecture, Civil Engineering & Construction business type with AEC
project operations](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/799).

## What the issue asks for, and the one boundary that shapes everything

A first-class business type for **architecture offices, civil/structural engineering companies,
contractors, design & build firms, consulting/supervision teams and individual professionals** —
without creating a fifth standalone app and without a parallel project-management system.

The platform keeps exactly four standalone apps (Accounting, Growth & Marketing, CRM, Website
Management); My Workspace stays an entitlement/work area, not an app. AEC functionality is reached
through:

```
architecture_construction → operating profile → enabled AEC capabilities
                          → My Workspace + Accounting + CRM + Growth + Website + AI
```

Everything that already exists — `ai_projects` as the canonical project, phases, tasks and
dependencies, project members and roles, project templates, project contracts, documents,
approvals, events, `journal_entries.project_id` as the project cost-centre dimension, CRM
`parties` as the canonical client/company/supplier identity, the media library, the permission
system and the AI tools — is **extended, never duplicated**. Actual cost stays in Accounting; A/R,
A/P, receipts and payments stay Accounting-owned; customer-relationship contracts stay CRM-owned;
project execution contracts stay Workspace-owned.

## Wave 1 — the industry foundation (implemented, migration 0193)

What shipped:

| Surface | Change |
|---|---|
| Registry | `architecture_construction` in `src/lib/industries.ts` with its Persian label «مهندسی عمران، معماری و پیمانکاری» (English: *Architecture, Civil Engineering & Construction*), and enabled in `ENABLED_INDUSTRIES` so `/welcome`, the platform picker and the provision dialog offer it |
| Profile | `INDUSTRY_PROFILES.architecture_construction` — brand «عمران، معماری و پیمانکاری», the core module set and nothing else, its own nouns (`صورتحساب`, `خدمات مهندسی`), `salesModel: retail_invoice` and restaurant-shaped feature flags seeded off at provision |
| Database | `migrations/0193_architecture_construction_industry.sql` widens `businesses_industry_check` to ten values — additive, idempotent, no new tables and no backfill |
| Chart of accounts | `ARCHITECTURE_CONSTRUCTION_COA_TEMPLATE`: three revenues (design/engineering, supervision/consulting, contracting/execution), retention receivable and payable (حسن انجام کار), contract work in progress, subcontractor payable, and direct project cost split three ways as the trade's cost of sales |
| Posting/report wiring | `accounting-posting-rules.ts`, `retail-stock-posting-rules.ts`, `retail-invoice-service.ts` and the two online-order ingest maps answer for the new industry; the statement's default revenue line is 4610 with 4620/4630 named as the alternate revenues |
| Tests | A dedicated profile block, AEC chart assertions (including "no hospitality account leaks in"), the AEC rows in the posting/COA suites, and real-database coverage in `integration/business-industry.integration.test.ts`: provisioning stores the industry, seeds the AEC chart and *not* the café's, and turns the restaurant features off |
| CI guard | `src/lib/industry-coverage.test.ts` |

### Decision 1 — the trade is POS-less, and that is the point

The profile grants `[...CORE_MODULES]` only: no `pos`, no `orders`, no `tables`/`waiter`/`kitchen`/
`reservations`/`delivery`, no `inventory`/`menu`, no `stock` and none of the trade-goods catalogue
pages. An AEC business reaches Accounting (ledger, reports, journal, cheques, payroll, fixed
assets), CRM and `parties`, Growth & Marketing, Website, the media library and the assistant, and
its operational centre is My Workspace — which is deliberately *not* a module key: the workspace
shell and `/projects` are ungated for every trade, so there is nothing for a key to hide.

`service_saas` set the precedent for a trade with no counter; AEC follows it, and the coverage
suite now states the rule for every trade at once ("no non-F&B industry gets a restaurant
module").

### Decision 2 — the chart is built by subtracting from F&B, like the service chart

`ARCHITECTURE_CONSTRUCTION_COA_TEMPLATE` filters the F&B template and then adds the trade's own
lines, exactly as `SERVICE_SAAS_COA_TEMPLATE` does. That keeps every shared Iranian accounting
control (cheques, payroll, VAT, penalties, fixed assets, marketing) present *by construction* —
the drift that Phase 30 had to repair — while making the removal explicit and testable: the
hospitality channels, the service charge, the delivery-marketplace commission and the kitchen
inventory machinery (recipe costing, waste, count variance, production conversion) are removed by
code, and `coa-template.test.ts` fails if any of them reappears.

Retention, contract work in progress and subcontractor payable are seeded ahead of the waves that
post to them: the chart a business is *given* should be the chart its trade actually uses, and
`seedChartOfAccounts` is additive and idempotent, so a later migration only ever adds.

### Decision 3 — a CI guard, because the compiler only catches half of it

Adding an industry to the registry is a compile error in every `Record<Industry, …>` — that is how
Wave 1's own implementation found all nine of them. What `tsc` cannot see is everything outside its
exhaustiveness rules: the SQL check constraint (whose omission fails at runtime, on the first
provision), `Partial<Record<…>>` and hand-written arrays, and test fixtures that restate the list.

`src/lib/industry-coverage.test.ts` asserts: every industry has a unique label, is offered by the
setup wizard, has a branded profile whose modules all resolve to an app (or to a documented
shell module), has a valid chart carrying its own cost-of-sales list and inventory account, posts
only to accounts its chart carries, walks a wizard that starts at the beginning, and reaches at
least one app; the newest `businesses_industry_check` in `migrations/` names every industry exactly
once; and no non-test source file restates an industry list — a hard-coded list of three or more
keys must *be* one of the exported registry sets (`INDUSTRIES`,
`PRODUCT_WORKSPACE_INDUSTRIES`, `TRADE_GOODS_INDUSTRIES`), which is why `reports.ts` and the
merchandising matrix route now import the trade-goods set instead of repeating it.

## Wave 2 — the AEC project profile + operating profiles (implemented, migration 0194)

What shipped:

| Surface | Change |
|---|---|
| Catalogue | `src/lib/aec.ts` — the eight **operating profiles** (`architecture_office`, `civil_engineering`, `contractor`, `design_build`, `consulting_supervision`, `multidisciplinary`, `team`, `individual`), the eleven **specialties**, nineteen **capability keys** and the twenty-two **participant roles** from §2 and §6, each with its Persian label. A profile is nothing but a preset over capabilities, and an explicit override beats the preset in both directions |
| Database | `migrations/0194_aec_profiles_and_participants.sql` — `aec_business_profiles` (one row per business: profile, specialties, delta-only `capability_overrides`), `aec_project_profiles` (1:1 with `ai_projects`: number, category, site, areas, floor count, coordinates, employer/consultant/contractor parties, project manager, contract and delivery method, permits, planned vs actual dates, planned vs reported progress, notes) and `aec_project_participants` (party + professional role + contact + window). All three FORCE RLS with the standard policy |
| Tenant integrity | The project key is the composite `(business_id, project_id)`, so a cross-tenant project reference cannot be written by any SQL; a trigger refuses a party or user from another business (and an archived or merged-away party), which is the one shape a composite FK cannot express because `business_id` is NOT NULL and cannot be `SET NULL` |
| Service | `src/lib/aec-service.ts` — load/save the business profile (refusing any non-AEC industry with `industry_mismatch`), load/upsert a project's profile (full save or partial patch), and list/add/update/remove participants with the role checked against the resolved capability set (`role_not_allowed`) |
| API | `GET/PUT /api/aec/profile` on `settings.manage`; `GET/PUT /api/aec/projects/[id]/profile` and `GET/POST|PATCH|DELETE /api/aec/projects/[id]/participants*` on `workspace.view`/`workspace.manage` **intersected with the project role** (`requireProjectCapability`), per §24 |
| Setup | A new optional wizard step `aec_profile` (`/setup/aec-profile`) placed right after `business` and walked by the AEC industry only — the issue's "after choosing the industry, the business picks an operating profile". Skipping it keeps the default preset |
| Settings | The same form inside «تنظیمات ← کسبوکار و شعبه» for an AEC business: profile cards, specialty chips and the nineteen capability switches, with non-shipped capabilities honestly labelled «بهزودی» |
| Tests | `src/lib/aec.test.ts` (33): preset arithmetic per profile, overrides in both directions, normalization, role gating, picker ordering, and a migration-text contract that the four CHECK lists equal the code's catalogues; `integration/aec.integration.test.ts` (14): RLS on all three tables, round-trips, `industry_mismatch`, delta-only overrides, the database refusing a foreign party/project, role gating, duplicate refusal, and "a participant is a record, not a grant"; the four new party references are classified in `party-merge-references.ts` |

### Decision 4 — capabilities, not profiles, are what the product asks about

`hasAecCapability`/`aecParticipantRoleAllowed` are the only questions any screen or route asks. A
profile is a *preset over those capabilities*: choosing `contractor` turns fifteen on at once, and
every one of them can be switched individually afterwards (an override is stored only when it
differs from the preset, so a future change to a profile's definition is not frozen out by a
tenant that never meant to override it). This is what makes §2's "hide contractor-heavy
functionality unless explicitly enabled" mechanical rather than a pile of `if (profile === …)`
checks scattered across the app.

The catalogue is deliberately declared **ahead of the waves that implement it** (BOQ, document
control, site execution, commercial controls): the preset a business is given now is the one those
waves will read, and `AEC_LIVE_CAPABILITIES` marks the two whose screens already exist so the
settings panel does not imply more than is built. Nothing in Wave 2 gates on an unshipped
capability.

### Decision 5 — a participant is a record, never a grant

`aec_project_participants` is additive to `workspace_members` and cannot substitute for it: a row
names an external company or person in a professional role and creates no user, no session, no
membership and no permission. Internal access is still the platform permission ∩ the project role.
The integration suite asserts that recording a participant leaves `users` and `workspace_members`
counts unchanged, so "external parties must not gain business-wide access" is a tested property
rather than a comment.

## Wave 3 — the project cockpit, blueprints and widgets (implemented, migration 0195)

What shipped:

| Surface | Change |
|---|---|
| Cockpit | `src/lib/aec-cockpit.ts` — issue §21's tab list as data: every section with the capability that gates it and the wave that builds it. `aecProjectTabs` composes the project page's bar from it: an AEC project's tabs take their industry names («شناسنامهٔ پروژه»), gains «طرف‌های پروژه» when the capability is on, and a section whose wave has not shipped is absent rather than greyed out |
| Project profile UI | «شناسنامهٔ پروژه» — §5's record on screen: number, category, site, areas, floor count, coordinates, employer/consultant/contractor parties, project manager, contract and delivery methods, permits, planned vs actual dates, and **planned vs reported physical progress side by side with the gap named**. Gregorian in the database, Shamsi on every field (JalaliDatePicker / DateCell) |
| Participants UI | «طرف‌های پروژه» — §6's external participants over the business's party directory, with the role picker built from `lookups.participantRoles` (the list the API enforces, so it cannot offer a role that will be refused) and one line stating that a participant is a record, not a grant |
| Blueprints | `src/lib/workspace-aec-templates.ts` — the six §4 templates (Architecture Design, Civil/Structural, General Contractor, Design & Build, Interior/Renovation, Consulting/Supervision), scoped by industry in `listTemplates` so a café can neither see nor apply them, with `recommendedProfiles` for a «پیشنهادی» badge and ordering — a hint, never a gate |
| Widgets | `migrations/0195_aec_widget_templates.sql` — three recommended AI widgets (projects at risk, pending approvals, contract expiry) for `architecture_construction` only. Deliberately three of the issue's thirteen: the rest name sections that arrive in Waves 4–9, and a recommended widget for a section with no data is a prompt that can only hallucinate |
| Assistant | `src/lib/aec-ai-tools.ts` — §23's two read tools, `get_aec_project_financial_health` and `list_delayed_project_activities`, composed from `projectReport`, `loadAecProjectProfile`, `listWorkspaceTasks` and `listPhases` so an answer and the cockpit can never disagree. Read-only, on `workspace.view`, refused with a sentence for another industry, and exposed over MCP with the rest of the read tools |
| Shared picker | `GET /api/workspace/lookups` carries the resolved capability list for an AEC tenant, next to the participant roles it already served, so the project page needs no extra request and a café's page never sees an `industry_mismatch` for a read it had to make |
| Fix | `handleAecError` rethrew the workspace module's per-project refusals (`not_a_project_member`, `insufficient_project_role`, …) as 500s because those codes are not AEC's; it now delegates what it does not own to `handleWorkspaceError` |

### Decision 6 — a capability decides a tab, and an unbuilt wave decides nothing

§21 asks for eighteen tabs and, two lines later, forbids showing every section to every profile.
Both are satisfied by making the catalogue *data* and the page derived: the sections a business
sees are the shipped ones its capabilities allow, so an individual architect gets a short bar
rather than an ERP, and the sections Waves 4–9 will build are described in the same list but never
rendered. When Wave 4 lands, `AEC_SHIPPED_WAVE` moves and the BOQ tab appears for the businesses
whose preset has `boq` — one line, no branching in the UI.

### Decision 7 — recommended, never required

Templates and widgets both follow the same rule: the platform *recommends* and the business
decides. A blueprint outside the recommended set is still offered (a contractor renovating an
office gets the fit-out template, simply not first), and a user may still create their own widget.
The super-admin's influence is an ordering and a badge, not a gate.

## Wave 4 — the BOQ, its revisions and the working budget (implemented, migration 0196)

What shipped:

| Surface | Change |
|---|---|
| Domain | `migrations/0196_aec_boq_and_estimates.sql` — five tables: `aec_estimates` → `aec_estimate_versions` → `aec_boq_sections` → `aec_boq_items`, plus `aec_estimate_events` as the audit trail. All five ENABLE + FORCE RLS with a `tenant_isolation` policy, composite `(business_id, …)` foreign keys, and a party reference guarded the same way 0194's are. The migration also widens `workspace_approvals.subject_type` with `estimate_version` and `workspace_activity.subject_type` with `estimate` |
| Arithmetic | `aec_boq_item_totals()` (BEFORE INSERT/UPDATE) owns `unit_price_rial` and `total_rial`: `unit_price = round(rate_sum × (1+waste)(1+overhead)(1+markup))` in integer basis points, `total = round(quantity × unit_price)`, with the unit price capped at 10¹⁵ and the line at `Number.MAX_SAFE_INTEGER`. A caller's own numbers are overwritten, not validated, so a stale tab cannot store a total that disagrees with the line's own rates. `aec_boq_version_totals()` follows with the revision's `item_count`/`total_rial`; `aec_estimate_version_guard()` freezes a revision the moment it leaves draft (approved → superseded is the only later move) and `aec_boq_line_guard()` refuses a section or line edit outside a draft |
| Pure half | `src/lib/aec-boq.ts` — the statuses and their transitions, the unit catalogue with the spellings a spreadsheet uses («متر مربع» → `m2`), the event labels, and `computeBoqItemTotals`, an exact BigInt mirror of the trigger (no floating point anywhere, half-up like PostgreSQL) so the form's live preview is the number the row will keep |
| Service | `src/lib/aec-boq-service.ts` — estimates, revisions with clone-forward, the draft's whole tree in one transaction (chapters and lines are replaced, which is what makes a reorder mean something), the event history, `boqVariance` and `approvedEstimateTotals` |
| API | `GET/POST /api/aec/projects/[id]/estimates` (the list and the variance in one response), `GET/PATCH/DELETE /api/aec/estimates/[id]`, `POST /api/aec/estimates/[id]/versions`, `GET/PUT /api/aec/boq/versions/[id]`, `POST /api/aec/boq/versions/[id]/status` (`submit \| start_review \| approve \| return`). Every one `withTenantScope` + `aecOwner` + `requireProjectCapability`; submit needs `workspace.manage`, a decision needs `workspace.approve` |
| Screen | `src/app/(app)/workspace/projects/[id]/boq-panel.tsx` — the BOQ tab: the project's approved total against Accounting's actual cost, the revision list with statuses, the selected revision's chapters and measured rows (inline-editable while it is a draft), one row's rate build-up in a dialog with the live totals, and the revision's history. Money is entered in the business's own unit and crosses the wire as integer Rial |
| Cockpit | `aec-cockpit.ts` — `boq` is now shipped, `AEC_SHIPPED_WAVE = 4`, and the tab sits between «اسناد» and «قراردادها», where §21 puts it |
| Assistant | `get_boq_variance` joins §23's two reads (capabilities catalogue, `ai.ts`'s function schema and Persian prompt, MCP) — the approved estimate against the ledger, and nothing invented |
| Party merge | `aec_boq_items.party_id` classified in `PARTY_REFERENCES` — the schema sweep requires every foreign key to `parties` to have an opinion, and this one's opinion is narrower than the rest: a `filterSql` clause moves **draft** lines only, because migration 0196's line guard refuses the UPDATE a merge would make to a frozen revision, and an approved estimate's supplier is part of what was approved |
| Data transfer | `workspace.boq_items` in `src/lib/data-transfer/registry.ts` + its adapter: 19 importable columns including the four rates, waste/overhead/markup, work package and an optional supplier, with the database's `unit_price_rial`/`total_rial` exported and never importable. A row names a project and lands in that project's estimate (created if the file names a new one), in a **draft** revision and in the chapter its title names; a row that cannot be placed comes back as a skipped row with a Persian reason rather than failing the file. The entity declares `requiresIndustry: "architecture_construction"`, and `entitiesForIndustry` — applied by `GET /api/data/entities` — is what keeps a café from ever seeing it |

### Decision 8 — the database owns the price, and the screen computes the same one

§7 lists eleven numbers per BOQ line, of which two are derived. A generated column cannot carry the
arithmetic (it is a three-factor product with rounding at the end), so the trigger computes and
stores them — and the form needs the same numbers *before* saving, or the editor is a guess. Rather
than duplicate the formula approximately (which is how a preview ends up a rial off, and a user
stops trusting it), `computeBoqItemTotals` is written as the mirror of the trigger in exact integer
arithmetic, and `integration/aec-boq.integration.test.ts` asserts both sides on the same inputs,
including a quantity of `0.00005` and a rate that lands on a half rial. One implementation would
have been better still; two that are proven equal every run is what the constraint allows.

### Decision 9 — approval is the workspace's approval, so §7's step lands in the queue that exists

A submitted revision files one row in `workspace_approvals` with `subject_type = 'estimate_version'`,
and `decideApproval` delegates to `decideEstimateApproval`. That means §7's approval appears in the
approvals counters, the project's approval list and the §23 assistant's "pending approvals" widget
with no new surface; it is gated by `workspace.approve`, the permission the rest of the queue uses;
and the revision's own `status` is the *projection* of the decision while `aec_estimate_events` is
the trail a reviewer reads. The one deliberate exception: deciding a request already in the queue is
**not** gated on the `boq` capability, or switching estimating off would strand an item nobody could
ever clear.

### Decision 10 — an approved estimate becomes the working budget, but a human number is never overwritten

§7 says approved estimates establish the project working budget. Approval therefore writes
`ai_projects.budget_rial`, and reports which of four things happened: `set` (the budget was empty),
`updated` (it still held the total of the revision this one supersedes — the platform's own number,
moved forward), `already_approved` (it already equals the new total), or `kept_manual` (a person
typed it, so the screen says the budget was left alone and where to change it). Actual cost is never
computed here: the variance reads `journal_entries.project_id` through the ledger, and the BOQ
domain owns five tables, none of which is a cost ledger — asserted in the integration suite rather
than promised in a comment.

## Wave 5 — drawing revision control and transmittals (implemented, migration 0197)

What shipped:

| Surface | Change |
|---|---|
| Domain | `migrations/0197_aec_document_control.sql` — five tables: `aec_documents` (the register), `aec_document_revisions`, `aec_transmittals`, `aec_transmittal_items` and `aec_transmittal_recipients`. All five ENABLE + FORCE RLS with a `tenant_isolation` policy and composite `(business_id, …)` foreign keys; both party references are guarded the way 0194's are; the migration also widens `workspace_activity.subject_type` with `document_revision` and `transmittal`, and seeds a «آخرین بازنگری نقشه‌ها» widget for the industry |
| Storage | A revision points at a `media_assets` file, and the service files it in `workspace_documents` — the platform's existing document record, with its own version chain (`supersedes_id`). §9's "no parallel document store" is therefore structural: there is no second byte store, no second upload path, and the documents screen shows an issued drawing next to any other project document |
| Immutability | `aec_document_revision_guard()` allows exactly draft → issued → superseded and refuses any content change once a revision leaves draft; `aec_freeze_issued_revision_file()` stops the underlying `workspace_documents` row from being re-pointed at another file or renamed; `aec_transmittal_guard()` freezes number, sender, date, purpose and comments the moment a transmittal is issued, and `aec_transmittal_line_guard()`/`aec_transmittal_recipient_guard()` freeze its lines (the recipients' one keeps the acknowledgement exception). "A new revision must never overwrite a historical approved file" is a database rule, not a service convention |
| Latest revision | `aec_document_revision_totals()` derives `latest_revision_id/no/code/status` and `revision_count` on the register row, so "latest" cannot drift from the revision list and needs no read-time sort; full history stays readable in the same row |
| Transmittal integrity | `aec_transmittal_item_snapshot()` copies the document number, title, revision code and issue purpose onto the line from the revision — a client cannot claim a transmittal carried a revision it did not. Issuing one transmittal is a single transaction: the revisions go out with the transmittal's purpose (if they had none), earlier issued revisions of the same document become superseded, and both sides freeze together |
| Pure half | `src/lib/aec-docs.ts` — the seven §9 issue purposes with Persian labels, the eight document types, the discipline list taken from `AEC_SPECIALTY_LABELS`, both status models with their transition tables, `pendingAcknowledgements`/`isFullyAcknowledged`, and revision-code arithmetic (`A`…`Z`, `AA`…) |
| Service | `src/lib/aec-doc-service.ts` — the register's CRUD, revisions (a new one is `max + 1` and links the file, or an existing `workspace_documents` row), transmittals with wholesale line/recipient replacement while draft, `issueTransmittal`, `acknowledgeTransmittal` (defaults to the first pending recipient, flips the transmittal to `acknowledged` on the last required signature) and the assistant's read |
| API | `GET/POST /api/aec/projects/[id]/documents`, `GET/PATCH/DELETE /api/aec/documents/[id]`, `GET/POST /api/aec/documents/[id]/revisions`, `PATCH/DELETE /api/aec/revisions/[id]`, `GET/POST /api/aec/projects/[id]/transmittals`, `GET/PATCH/DELETE /api/aec/transmittals/[id]`, `POST /api/aec/transmittals/[id]/status` (`issue \| acknowledge`). Every one `withTenantScope` + `aecOwner` + `requireProjectCapability` |
| Permission | `workspace.documents_issue` — new, high risk, audited, implying `workspace.view`. Reads need `workspace.view`, drafting needs `workspace.manage`, **issuing** needs `workspace.documents_issue`, and acknowledging a receipt stays `workspace.manage` because it is a receipt rather than a decision (§24) |
| Screen | `src/app/(app)/workspace/projects/[id]/documents-panel.tsx` — «نقشه‌ها و اسناد» above the generic documents section: the register with its latest revision, the full revision history with its statuses, and the transmittal list with a drawer holding lines, recipients and receipts. No control is offered where the API would refuse: the issue button appears only for a member who holds the issuing key, and edit/delete only on a draft revision |
| Cockpit | `aec-cockpit.ts` — `documents` is now shipped, `AEC_SHIPPED_WAVE = 5`, and the «اسناد» tab (named «نقشه‌ها و اسناد» for a business with the capability) is the register |
| Assistant | `get_latest_drawing_revision` joins §23's reads (capabilities catalogue, `ai.ts`'s function schema and Persian prompt, MCP) — one row per document with its current revision, optionally filtered by discipline or a search term |
| Party merge | `aec_transmittals.sender_party_id` and `aec_transmittal_recipients.party_id` classified in `PARTY_REFERENCES`, both moving **drafts only** — a frozen transmittal keeps the sender and recipient it was issued to, because the recipient row is also the receipt |

### Decision 11 — the register is a register, not a second media library

§9 asks for a lot of metadata per drawing: number, discipline, type, revision, status, purpose,
prepared/checked/approved/issued by, and a link to the file. The temptation is a new document table
with its own upload; the requirement is the opposite, and both §9 and the repo's standing rule point
the same way. So `aec_documents` / `aec_document_revisions` own the *engineering* metadata, and the
bytes stay in `media_assets` reached through a `workspace_documents` row (created by the service when
a revision is filed from the library, or linked when it already exists). A drawing therefore appears
in the project's documents list with its own supersede chain, the media library keeps its single
storage charge and single access check, and the revision trigger freezes the file row so
"a new revision never overwrites an approved one" is enforced where the file actually lives.

### Decision 12 — issuing moves the whole register in one transaction, and the database owns what "issued" means

An issued drawing is a claim about the world: this revision, for this purpose, went to these people,
on this date. That claim is spread over four tables, so it is written in one transaction and its
invariants are triggers rather than service checks: a transmittal cannot be issued empty or without
recipients (`aec_transmittal_guard`), a line's identity is copied from the revision
(`aec_transmittal_item_snapshot`), earlier issued revisions are superseded and both sides freeze in
the same statement that flips the status. The service still checks the same conditions first —
because a Persian error code is a better answer than a constraint name — and
`integration/aec-document-control.integration.test.ts` asserts the raw-SQL path is refused too, which
is how the shared items/recipients guard and a stale `filterSql` alias were caught before review.

### Decision 13 — "latest revision" is derived, so it cannot drift

The register row keeps `latest_revision_id/no/code/status` and `revision_count`, recomputed by the
revision trigger on every insert, update and delete. The alternative — sorting the revisions on read —
looks harmless and is not: two screens that sort differently (code vs number, ascending vs
descending) eventually disagree, and "which revision is current" is the one question a drawing
register must never answer ambiguously. Deriving it means the register, the tab's KPI row, the widget
and the assistant's `get_latest_drawing_revision` all read one stored answer, while the full history
stays readable beside it.

## Wave 6 — RFIs and submittals (implemented, migration 0198)

What shipped:

| Surface | Change |
|---|---|
| Domain | `migrations/0198_aec_rfi_and_submittals.sql` — three tables: `aec_rfis` (the question register), `aec_submittals` (the register of what is sent for review) and `aec_submittal_revisions` (one submission of it, with its own status, file, reviewer and determination). All three ENABLE + FORCE RLS with a `tenant_isolation` policy and composite `(business_id, …)` foreign keys; both party references are guarded the way 0194's are; the migration widens `workspace_approvals.subject_type` with `submittal_revision` and `workspace_activity.subject_type` with `rfi` and `submittal`, and seeds «RFIهای بدون پاسخ» / «سابمیتالهای منتظر تأیید» widgets for the industry |
| Storage | A submittal revision's file and an RFI's attachments are `workspace_documents` rows: the revision links one (created from a `media_assets` file, exactly as a drawing revision does), and attachments are documents of the project linked by two new nullable columns (`workspace_documents.rfi_id`, `.submittal_id`). There is no second byte store and no second upload path — §9's rule, applied to §10 and §11 |
| Immutability | `aec_rfi_guard()` allows exactly `draft → open → answered → closed` plus cancellation, refuses any change to the number, subject or question once the RFI has been asked, refuses a second write to the response, and refuses a delete that is not a draft; `aec_submittal_revision_guard()` freezes a revision's file, due date, notes, submitter and reviewer the moment it leaves draft (the reviewer is claimed by the transition itself) and refuses deletion outside draft; `aec_submittal_guard()` refuses a direct write to the four derived columns. §33's "RFI response" and "submittal decision" are therefore history in the database, not only in the service |
| Derived latest revision | `aec_submittal_revision_totals()` derives `latest_revision_id/no/status` and `revision_count` on the register row (announcing itself through a transaction-local marker, so the register's guard can refuse every other write) — "which revision is current" is one stored answer, never a read-time sort |
| Approval | §11's review rides the **existing** `workspace_approvals` queue as a `subject_type = 'submittal_revision'` row filed by `submitSubmittalRevision`, decided on `workspace.approve`. No second approval mechanism: the queue, the dashboard counters and the widgets learn about submittals for free. The queue's binary decision maps onto `approved`/`rejected`; the reviewer's two finer outcomes («تأیید با نظر» and «اصلاح و ارسال مجدد») live on the submittal screen, because the queue cannot say which of them a bare "reject" meant |
| Pure half | `src/lib/aec-rfi.ts` — §10's five statuses with their labels and transition table, §11's eight statuses, eight submission types, the four review determinations with Persian labels, `isRfiOverdue`/`isSubmittalOverdue` against the business's own today, `isRfiWaiting`/`isSubmittalWithAuthor`/`isSubmittalDecided`, and the editability predicates the screens and the service share |
| Service | `src/lib/aec-rfi-service.ts` — RFI CRUD with `applyRfiAction(open/answer/close/cancel)`, attachment replacement through `workspace_documents`, submittal CRUD with revision 1 created in the same transaction as the register row, `addSubmittalRevision`, `submitSubmittalRevision` (freezes the revision and files one approval), `startSubmittalReview`, `decideSubmittalRevision` («اصلاح و ارسال مجدد» inserts revision n+1 in the same transaction), `closeSubmittalRevision`, the queue-side `decideSubmittalApproval`, and `pendingRfis`/`pendingSubmittals` for the assistant and the widgets |
| API | `GET/POST /api/aec/projects/[id]/rfis`, `GET/PATCH/DELETE /api/aec/rfis/[id]`, `POST /api/aec/rfis/[id]/status` (`open` \| `answer` \| `close` \| `cancel`), `GET/POST /api/aec/projects/[id]/submittals`, `GET/PATCH/DELETE /api/aec/submittals/[id]`, `POST /api/aec/submittals/[id]/revisions`, `PATCH/DELETE /api/aec/submittal-revisions/[id]`, `POST /api/aec/submittal-revisions/[id]/status` (`submit` \| `start_review` \| `decide` \| `close`). Every one `withTenantScope` + `aecOwner` + `requireProjectCapability`, on the same read/write split as the rest of the module |
| Permission | **No new key.** Reading needs `workspace.view`, raising/editing/answering/closing needs `workspace.manage`, and a review determination needs `workspace.approve` through the approvals queue — §24's rule (a high-risk decision must not inherit ordinary edit rights) is satisfied by the existing approval key, and a new `rfi.manage`/`submittal.manage` pair would have been a second authorization vocabulary for the same acts |
| Screens | `src/app/(app)/workspace/projects/[id]/rfis-panel.tsx` and `submittals-panel.tsx` — «استعلامها (RFI)» and «ارسال مدارک (Submittal)»: the register with overdue dates marked, the question/answer panel, the submission cycle with each revision's determination, and one control per legal move (a draft looks editable, a submitted revision looks sent) |
| Cockpit | `aec-cockpit.ts` — `rfis` and `submittals` are shipped, `AEC_SHIPPED_WAVE = 6`, and both own a tab: an RFI is a question asked of a client, so every AEC shape gets the tab; submittals ride `document_control`, because they are a document cycle pointing at §9's register |
| Assistant | `list_pending_rfis` and `list_pending_submittals` join §23's reads (capabilities catalogue, `ai.ts`'s function schemas and Persian prompt, MCP summaries) — the issue names both, and they answer the two Persian questions §23 writes out («RFIهای بدون پاسخ این هفته چیست؟» and «چه سابمیتالهایی منتظر تأیید هستند؟») from the same service the tabs read |
| Notifications | Two new event keys, `aec.rfi_overdue` and `aec.submittal_overdue`, produced by a scan in `src/lib/notification-scans.ts` beside the low-stock one (a record becomes overdue by the passage of a date, not by a write, so there is nothing to emit an event from) and delivered by the existing engine — §29's "do not build a second notification engine" |
| Party merge | `aec_rfis.responsible_party_id` and `aec_submittals.responsible_party_id` classified in `PARTY_REFERENCES`, both moving with the surviving party — neither is part of what a frozen record froze, and leaving one behind would make the next write fail the trigger |

### Decision 14 — an RFI is not capability-gated, and a submittal is

§10's register is what any AEC business runs on: an individual architect asks the client a question
as surely as a contractor does, and a question with a due date is the whole feature. So the RFI tab
and its API need no capability — only the industry. Submittals are different in kind: §11 is a
document *cycle* over §9's drawing register (a shop drawing, a sample, a method statement), so it
rides `document_control`. The tab and the API therefore refuse on exactly the same terms, and a
business that switches document control off sees the RFI tab unchanged and no submittal tab at all —
rather than an empty register it could never fill.

### Decision 15 — the reviewer's four outcomes, and why the queue only sees two

§11 names four ways a review can end — Approved, Approved with Comments, Revise & Resubmit,
Rejected — and the temptation is to model them as one status dropdown. They are not four labels, they
are four different things to do next, which is why the screen offers four buttons and why «اصلاح و
ارسال مجدد» inserts revision n+1 in the same transaction: leaving that to a second click lets a
returned submittal sit with nothing to edit. The approvals queue is a generic mechanism with a binary
decision, so `decideSubmittalApproval` maps it onto `approved`/`rejected` and never guesses which of
the two *rejections* a reviewer meant; the finer pair lives where it can be expressed. The revision's
status is the projection of the reviewer's act either way — one implementation of "approved" and one
of "returned", whichever screen records it.

### Decision 16 — a question freezes when it is asked, an answer when it is given

§33 asks for the RFI response and the submittal decision to be immutable history, and the cheapest
wrong answer is to trust the service. So the freeze is in the triggers, and its exact shape was chosen
from the domain rather than from convenience: on an RFI the number, subject and question freeze the
moment it leaves draft (an asked question that can be reworded is not a record of what was asked), the
response freezes the moment it exists (a second write is refused, which is why the service can only
write one through `answer`), and a non-draft cannot be deleted. On a submittal revision everything the
reviewer saw freezes together — the file, the due date, the notes, the submitter — and the reviewer's
own identity is claimed by the transition that picks the submission up or decides it, so changing it
afterwards is refused while recording the determination is not. Service-level checks are not enough:
`integration/aec-rfi.integration.test.ts` drives the same rules through raw SQL from a connection that
bypasses every service check.

### Decision 17 — one overdue definition, four readers

An overdue RFI is `status = 'open'` with a due date before the business's own today; an overdue
submittal is a revision waiting on a reviewer by the same rule. That sentence lives in
`src/lib/aec-rfi.ts` and is used by the tab's KPI row, the register's red date, the assistant's two
pending reads and the notification scan — so the number a manager sees on a phone, the number in a
chat answer and the number that triggers a reminder cannot drift apart. §10's "the system must clearly
surface overdue RFIs" is therefore one predicate with several callers rather than several queries that
agree today.

## Wave 7 — site execution (implemented, migration 0199)

What shipped:

| Surface | Change |
|---|---|
| Domain | `migrations/0199_aec_site_execution.sql` — six tables: `aec_site_logs` (the day) with `aec_site_log_lines` (its crews, plant, deliveries, delays, incidents, instructions and visitors), `aec_inspection_checklists` with `aec_inspection_checklist_items` (the firm's templates), and `aec_site_issues` (the one register) with `aec_site_issue_checks` (the checklist as it was carried out). All six ENABLE + FORCE RLS with a `tenant_isolation` policy, composite `(business_id, …)` foreign keys, an `(project_id, log_date)` unique index and an `(project_id, issue_number)` unique index; the migration widens `workspace_activity.subject_type` with `site_log` and `site_issue` and seeds the «امروز در کارگاه» and «موارد باز کارگاه» widgets |
| Immutability | `aec_site_log_guard()` allows exactly `draft ↔ submitted`, refuses every content change to a submitted day and refuses its deletion; `aec_site_log_line_guard()` freezes the lines with the header, because a signed day whose attendance could still be edited is not signed. `aec_site_issue_guard()` is the one chain for all seven kinds (`open → in_progress → resolved → closed`, `cancelled` until work starts, `resolved → in_progress` for a failed verification) and enforces §14's closeout: a result is required before an inspection or a handover leaves work, a close needs a verifier, the verifier may not be the assignee, and a closed or cancelled issue accepts no further change and cannot be deleted. `aec_site_issue_check_guard()` freezes a closed issue's checklist with it. §33's "inspection result" and "NCR closeout" are therefore history in the database, not only in the service |
| Line shapes | The kind's inputs are one table, `SITE_LOG_LINE_SHAPES` in `src/lib/aec-site.ts`: attendance has a headcount, a delivery a quantity and a unit, plant hours, a visitor neither a party nor a headcount. The same shape is a CHECK on `aec_site_log_lines`, so the form cannot ask for a field the schema refuses and a raw INSERT cannot invent one |
| Pure half | `src/lib/aec-site.ts` — §13's two day statuses, seven line kinds and their shapes, §14's seven issue kinds with their number prefixes and their capability, four severities, eight categories, five statuses with the transition table, the four acts with `siteIssueActionNeedsApproval`, the three inspection results and the four checklist-line results, `isSiteIssueOverdue` (the one definition the tab, the scan and the assistant share), and `summariseSiteChecks`/`summariseSiteLogLines` |
| Service | `src/lib/aec-site-service.ts` — day CRUD with wholesale line replacement, `applySiteLogAction(submit/reopen)`, issue CRUD with per-kind numbering under `pg_advisory_xact_lock`, `applySiteIssueAction(start/resolve/close/cancel)`, checklist CRUD (`createChecklist`/`updateChecklist`/`deleteChecklist`) with the item snapshot onto an issue, attachment replacement, and `pendingSiteIssues`/`overdueSiteIssues` for the widgets, the scan and the assistant |
| Storage | §13's "photos" and §14's "photos, evidence" are the platform's files: `workspace_documents` gains nullable `site_log_id`/`site_issue_id` columns (migration 0199) and `aec_assert_attachment_owned()` refuses a document whose project or business disagrees with the record it points at. This wave also extracts the four registers' shared half into `src/lib/workspace-document-links.ts` and moves `aec-rfi-service.ts` onto it, so "attach a file to a register row" is one implementation rather than four |
| API | `GET/POST /api/aec/projects/[id]/site-logs`, `GET/PATCH/DELETE /api/aec/site-logs/[id]`, `POST /api/aec/site-logs/[id]/status` (`submit` \| `reopen`), `GET/POST /api/aec/projects/[id]/site-issues`, `GET/PATCH/DELETE /api/aec/site-issues/[id]`, `POST /api/aec/site-issues/[id]/status` (`start` \| `resolve` \| `close` \| `cancel`), `GET/POST /api/aec/checklists`, `GET/PATCH/DELETE /api/aec/checklists/[id]`. Every one `withTenantScope` + `aecOwner` + `requireProjectCapability` (the checklists are business-scoped, so they check the project role only when the template is scoped to one) |
| Permission | **No new key.** Reading is `workspace.view`; raising, editing, starting, resolving and cancelling are `workspace.manage`; the closeout verification is `workspace.approve` — §24's "a decision must not inherit ordinary edit rights" applied to §14's closeout, and the same key the approvals queue already uses |
| Screens | `src/app/(app)/workspace/projects/[id]/site-panel.tsx` («کارگاه و گزارش روزانه»: the day register, the day's card with its lines, evidence and the submit/reopen control, and «روزنگار» — the diary view that merges the days with the quality register on one timeline), `inspections-panel.tsx` («بازرسی و کنترل کیفیت»: one register over the seven kinds with the four acts and the closeout dialog) and `checklists-panel.tsx` (the firm's inspection and handover templates, with their items and their active switch). A signed day renders as text with a reopen button, because offering an edit that only ever fails is worse than offering none |
| Cockpit | `aec-cockpit.ts` — `site` and `inspections` are shipped, `AEC_SHIPPED_WAVE = 7`: `site` rides `site_operations` and `inspections` rides `qa_qc`, so a designer sees neither, a supervisor sees the register without the daily log, and a contractor sees both. `material_tracking` is still absent from `AEC_LIVE_CAPABILITIES` on purpose — Wave 9 keeps it reserved (delivery tracking rides `procurement`; an AEC tenant has no stock ledger to track materials in) — so a kind with no register behind it cannot leak into an enabled tab |
| Assistant | `list_site_issues` joins §23's reads — open inspections, NCRs, corrective actions, snags and HSE observations, worst first, with the same `pendingSiteIssues` the tab's KPI row reads. §23 now names seven AEC tools, and the Persian prompt answers «چه چیزی در کارگاه باز است» from the same function the screen uses |
| Notifications | Two new event keys, `aec.inspection_due` and `aec.snag_overdue`, produced by the existing hourly AEC sweep in `src/lib/notification-scans.ts` (no second engine, no new tick) and split by kind so a manager can switch the inspection reminders and the defect reminders off separately. This wave also fixes the sweep's first line: a non-AEC business now costs it one industry read instead of an hourly logged exception, which is what the scan's own comment already claimed |
| Party merge | `aec_site_log_lines.party_id` (moves while the day is a draft, refused once it is submitted — a frozen day's crew is part of what froze) and `aec_site_issues.responsible_party_id` (moves while the issue is open) classified in `PARTY_REFERENCES`; `integration/party-merge-coverage.integration.test.ts` derives its coverage from PostgreSQL, so it proves the pair is complete |
| Isolation | `integration/aec.integration.test.ts`'s RLS sweep now walks **22** tables (the six new ones included), and `integration/aec-site.integration.test.ts` (16 tests) adds the §13 and §14 rules the pure suite cannot reach: the signed day and its lines refused by raw SQL, the one-day-per-date unique index, the line CHECK shape, the four-eyes close refused by the trigger, the frozen closed record, the checklist snapshot surviving both an edit and a delete of the template, and the two capabilities' gates |

### Decision 18 — one register, seven kinds

§14 lists nine artifacts — inspection requests, checklists, quality inspections, NCRs, corrective
actions, punch/snags, the handover checklist, HSE observations — and then states the fields **once**:
project/location, category, severity, responsible party, raised by, assigned to, due date, photos,
evidence, status, closeout verification, approval, activity history. Nine tables with that same column
list would be nine migrations of duplication, nine ways for "closed" to mean slightly different things
and nine places for the reminder scan to miss one. So the register keeps the kind in a column and
models the three things that genuinely differ explicitly: a result belongs to an inspection and a
handover (`issueNeedsResult`), a checklist does too (`issueSupportsChecks`), and a snag and an HSE
observation have their own capability switch (`snagging`, `hse`) — which is how "where enabled"
becomes a real gate rather than a hidden button. The consequence is visible on site: an NCR and a punch
item are referred to by different prefixes from the same queue (`NCR-004`, `SNG-011`), and one report
covers both without a second closeout definition.

### Decision 19 — a day is signed, and its lines inherit the signature

§13's daily log is the record of what happened on site, which is only worth something if "what the day
says" cannot change afterwards. The freeze is therefore in the trigger and it covers the **lines**:
`aec_site_log_line_guard` consults its header, so attendance, deliveries and incidents stop being
editable the moment the day is submitted — a signed day whose headcount could still move would be a
signature over an empty promise. Going back is allowed and explicit (`reopen`), because a site manager
genuinely does remember a late truck; what is *not* allowed is a silent edit, and the activity feed
records which of the two happened. The same reasoning gives the day its `(project_id, log_date)`
unique index: a site that reports twice on one date is not keeping a log, so the second report is an
edit of the first day, refused by the database rather than by a form hint.

### Decision 20 — the closeout is a permission and a four-eyes rule, and a failure loops back

§14 says an issue ends with "closeout verification", which is a decision about somebody else's work
rather than more site work. So closing needs `workspace.approve` while raising, starting, resolving
and cancelling need `workspace.manage`, and the service — and the trigger behind it — refuse a close
whose verifier is the issue's assignee. That single refusal is what turns "the snag list is empty" into
a claim somebody had to stand behind. The other half is what happens when the verification fails: the
issue goes back to `in_progress` on the **same** record (`resolved → in_progress`, the chain's one
backward edge), rather than being closed and re-raised as a second NCR — so the count of times a fix
came back is readable from one history instead of inferable from numbers on two rows.

### Decision 21 — a checklist is a snapshot, not a live reference

An inspection is carried out against the firm's checklist, and the temptation is to store the link and
read the items through it. That would mean editing the template tomorrow rewrites what was inspected
yesterday — the opposite of §33 — so the items are **copied** onto the issue (`aec_site_issue_checks`),
label, guidance and result included, and the link back to the template item is provenance that
`ON DELETE SET NULL` may drop without losing the record. Two database lessons came out of building it
that way. A composite foreign key cannot carry `ON DELETE SET NULL`: PostgreSQL nulls *every* column of
the key, `business_id` included, and that column is NOT NULL — so the reference to a template item is a
single-column FK and the same-business half is the trigger, exactly as the register's own nullable
links already do it. And the ownership predicate is not the CRM's: `parties` has no `archived_at`, so
the register asks `is_active AND merged_into_id IS NULL` like every other AEC register — a mismatch the
database suite caught, which is the reason §32 asks for these tests rather than for care.

Wave 7 leaves two issue items to the waves that own them, deliberately: an issue's "linked variation /
change order" and a day's "cost impact" are fields on the *variation*, which Wave 8 builds — the link
is owned by the later record, so neither register grows a column pointing at a table that does not
exist yet; and a day or an inspection drafted on site with no signal (§26's "excellent on mobile" and
the offline candidates) is a replication-domain decision, which Wave 10 still owns together with the
mobile capture flows (its report half is built; see «Wave 10» below). `material_tracking` stays out of `AEC_LIVE_CAPABILITIES` — Wave 9 shipped delivery
tracking on `procurement` instead and left the ledger switch reserved with its reason written down — so
no tab in this wave can show a delivery-tracking screen that does not exist.

## Wave 8 — commercial controls (implemented, migration 0200)

What shipped:

| Surface | Change |
|---|---|
| Domain | `migrations/0200_aec_commercial_controls.sql` — five tables: `aec_contract_commercials` (§17's AEC block, one row per `workspace_contracts` contract), `aec_variations` (§15, numbered `VO-001` per project), `aec_payment_certificates` (§16, numbered `PC-001`, `kind IN ('application','certificate')` for the two directions) with `aec_payment_certificate_lines` (the measurement, linked to BOQ items or free-labelled), and `aec_commercial_events` (§33's trail for both subjects). All five ENABLE + FORCE RLS with a `tenant_isolation` policy and `UNIQUE (business_id, id)`; `workspace_contracts` gains the `UNIQUE (business_id, id)` the composite keys need; `workspace_documents` gains nullable `variation_id`/`payment_certificate_id`; `workspace_approvals.subject_type` widens with `variation` and `payment_certificate` and `workspace_activity.subject_type` with the same two; the migration seeds §22's «صورت‌وضعیت‌های در انتظار» and «ریسک تجاری پروژه‌ها» widgets for the industry |
| Arithmetic | The certificate's net is the database's: `net_rial = gross − advance_recovery − retention − other_deductions − tax` with `approved_amount_rial <= net_rial`, and the measured lines must add up to the gross before a claim leaves draft. §15's status CHECKs make a priced order without an estimate, a submitted one without an amount and an approved one without an agreed figure impossible rows, so the service's codes and the schema agree instead of one backstopping the other |
| Immutability | `aec_variation_guard()` refuses every content change once an order has been submitted (the client's copy is the client's), refuses a delete that is not a draft, and freezes an implemented or cancelled order outright; `aec_certificate_guard()` refuses any `UPDATE` at all to a certified claim and any `DELETE` of a non-draft, and `aec_certificate_line_guard()` freezes a claim's lines with it. Withdrawal is the chain's own move (a rejected order is re-priced, a rejected claim returns to `draft`), which is §33's "immutable history" without a second audit table |
| The revised value | `aec_recompute_contract_revised_value()` and three triggers keep `aec_contract_commercials.revised_value_rial = workspace_contracts.value_rial + approved variations`, and a `BEFORE` trigger overwrites a hand-typed figure. The original contract amount, the approved BOQ revision and its lines are never written by an approval — §15's "must not rewrite the original contract amount, the original approved BOQ, old estimate versions" is a property of the schema rather than a promise in a service |
| Pure half | `src/lib/aec-commercial.ts` — §15's eight statuses and one chain with its two deliberate reopenings (`rejected → priced`, `submitted → priced`), its six sources, `isEditableVariation`/`isApprovedVariation`/`isOpenVariation`; §16's two kinds, six statuses and its cycle (`draft → submitted → under_review → certified \| rejected`, `rejected → draft`); `certificateTotals` (the CHECK, in TypeScript); `revisedContractValueRial`, `previousCertifiedRial`, `outstandingAdvanceRial`, `retentionTotalRial`; both action catalogues with their labels and events and one predicate each — `variationActionNeedsApproval` (false only for `price`, `submit`, `reopen`) and `certificateActionNeedsApproval` (false only for `submit`, `reopen`); and `COMMERCIAL_CAPABILITY_FOR` (`variations`, `progress_claims`, `financials`) |
| Service | `src/lib/aec-commercial-service.ts` — variation and claim CRUD with per-project numbering under `pg_advisory_xact_lock`, the two action chains with their preconditions, `decideVariationApproval`/`decideCertificateApproval` (the queue's half), §17's `saveContractCommercial` (which never writes the revised value), `getProjectCommercialSummary` (§20), and the four queues the widgets, the scan and the assistant read: `pendingVariations`, `pendingCertificates`, `expiringSecurities`, `certifiedClaimsAwaitingPayment` |
| API | `GET/POST /api/aec/projects/[id]/variations`, `GET/PATCH/DELETE /api/aec/variations/[id]`, `POST /api/aec/variations/[id]/status`, the same three for certificates, `GET /api/aec/projects/[id]/commercial` and `GET/PUT /api/aec/contracts/[id]/commercial`. Every one `withTenantScope` + `aecOwner` + `requireProjectCapability` (the contract block checks the project role only when the contract is project-scoped; a business-level framework agreement has none to check) |
| Permission | **No new key.** Reading is `workspace.view`; writing the registers, preparing an order and drafting or submitting a claim are `workspace.manage`; reviewing, approving, rejecting, implementing, cancelling and certifying are `workspace.approve` — §24's "change-order manage/approve", "commercial/payment certificate manage/approve" and "project financial view" expressed through the two keys the product already has, with the split asserted per route in `api-guards.test.ts` |
| Screens | `src/app/(app)/workspace/projects/[id]/variations-panel.tsx` («تغییرات»: the register with the four money figures side by side — estimated, cost impact, submitted, agreed — the contract-value line an approval will move, and the §33 trail), `certificates-panel.tsx` («صورت‌وضعیت و پرداخت»: both directions on one register, an arithmetic preview that never lets the net be typed, measurement lines that must sum to the gross, the previous/current certified pair, and the «تأییدشده ≠ وصول‌شده» note), `commercial-panel.tsx` (§20's cockpit and §17's per-contract block, mounted inside «مالی» behind the `financials` capability). Both registers get their own tabs after «مالی», because a change order moves the contract's value and a claim claims against it |
| Cockpit | `aec-cockpit.ts` — `changes` («تغییرات», `variations`), `payments` («صورت‌وضعیت و پرداخت», `progress_claims`) and `financials` («مالی پروژه») are shipped and `AEC_SHIPPED_WAVE = 8`; `AEC_LIVE_CAPABILITIES` is now 11, and `material_tracking` is still absent — Wave 9 keeps it reserved with the reason written next to the key |
| Assistant | §23's three commercial reads join the AEC tool set: `list_change_orders`, `list_payment_certificates` and `list_project_commercial_risks` (the last one merging pending changes, pending claims and expiring securities). `AEC_AI_TOOL_NAMES` is ten, and the pure suite pins the list literally |
| Notifications | Four event keys on the **existing** hourly AEC sweep — `aec.payment_certificate_pending` (a claim sent more than fourteen days ago), `aec.client_payment_overdue` (certified and still uncollected), `aec.guarantee_expiring` and `aec.insurance_expiring` — each with its own budget, so fifty late claims cannot silence the bond that expires next week |
| Party merge | `aec_variations.responsible_party_id` classified in `PARTY_REFERENCES` with `filterSql: status IN ('draft','priced')`: a merge re-points the party of an order still being prepared and leaves a submitted one naming the party it was raised against, which is what migration 0200's freeze and the registry's filter agree on |

### Decision 22 — the revised value is derived, and the contract is never rewritten

§15 says an approved variation "must not rewrite the original contract amount, the original approved
BOQ, or old estimate versions", and the tempting shortcut — add the approved amount to
`workspace_contracts.value_rial` and move on — destroys exactly the figure a claim is later argued
against. So the contract keeps its original value for good, the revised value lives on the contract's
*commercial* row, and the database recomputes it from the original plus the approved variations on
every relevant write. A `BEFORE` trigger overwrites a figure typed by hand, which makes "the revised
value" one answer rather than two, and the database suite asserts all three halves: the revised figure
moves, the contract does not, and the approved BOQ revision and its lines are byte-for-byte what they
were.

### Decision 23 — certified is not collected, so this wave stores no balance

§16's last line is the one that shapes the whole register: "Accounting remains authoritative for actual
A/R, A/P, receipts, payments, journal postings; Workspace manages the commercial certificate only —
never duplicate paid/received balances." So no table here has a paid or received column, and the
cockpit does not invent one. §20's actual cost is read from the ledger through `projectReport`
(`journal_lines` via `journal_entries.project_id`) and is `null` for an actor without `ledger.view` —
the same rule and the same reason the project report already uses, because «۰ ریال هزینه» is a claim
about money and an absent one is not. The figures only the books own (receipts, payments, A/R, A/P) are
*named* in `readInAccounting` rather than recomputed, and the four §20 figures that need registers this
build does not have yet (committed cost, cost to complete, forecast final cost, forecast margin) are
named in `awaitingWaves` with the wave that brings them. The «Project Margin» widget is deliberately
**not** seeded for the same reason: a margin computed from a cost nobody has booked is a
plausible-looking wrong number, which is worse than a missing one.

### Decision 24 — a decision in the queue is the review, so the queue walks that step

§15's chain is Draft → Priced → Submitted → Under Review → Approved, and §16's is
Draft → Submitted → Under Review → Certified. The approvals inbox offers exactly two buttons on a
pending row, and the first version of `decide*Approval` called `approve`/`certify` straight off the
submission — which neither chain allows, so approving a freshly submitted order from the inbox failed
with an invalid transition. The fix is not a wider transition table (a chain that can jump its own
review step is not a chain); the queue now takes the review step itself before deciding, because the
person deciding in the inbox *is* the reviewer. The database suite covers both subjects, and it is the
kind of defect that only a suite which walks the real path — submit, then decide *from the queue* —
can find.

### Decision 25 — three switches, not one, because they are three different businesses

`variations`, `progress_claims` and `financials` came into `AEC_LIVE_CAPABILITIES` together, and they
stay independent: a design office can watch a project's money (§20's cockpit, which is
`financials`) without ever raising a change order or certifying a claim, a contractor can raise changes
without issuing certificates, and a supervisor issues certificates against work somebody else
performed. The service asserts each domain against its own capability, and the database suite proves it
on one fixture — a design-preset business reads a cockpit and is refused both registers with
`capability_disabled`, not with a 403 about permissions.

### Decision 26 — the measurement is the claim, and the trigger is what says so

§16 asks for progress, work completed and the certified figure, and the tempting shape is a claim whose
gross is typed and whose lines are a note. Then the lines are decoration: two answers to one question,
and the one the client is paid against is whichever somebody looked at last. So when a claim has lines
they *are* the measurement — they must sum to the gross before the claim can leave draft — and the rule
is enforced in the service (with a code), in the route (a 409 rather than a 500) and in
`aec_certificate_guard()` (so a raw status flip is refused too). A draft, by contrast, is allowed to
disagree with itself: that is what drafting is, and the suite asserts both halves.

### What Wave 8 does and does not do about §30's reports

The issue's own wave list puts the **report set** in Wave 10 ("tools, recommended widgets, reports"),
and this wave respects that: what it owns is the data behind the three commercial entries on §30's list.
§30's "change-order exposure" is the change-order register plus `pendingVariations` and
`getProjectCommercialSummary.approvedVariationsRial`; "certificate/payment status" is the certificate
register plus `certifiedClaimsAwaitingPayment`; and "project margin" **cannot** be reported yet — the
margin needs committed cost and cost to complete, which were Wave 9's procurement registers — the
cockpit named the figure in `awaitingWaves` instead of printing a plausible number, and Wave 9 has
since filled that list in.
§30's "financial
amounts must use Accounting as the source where they represent posted financial facts" is Decision 23
above, and it is why the cockpit's actual cost is read from the ledger rather than kept here. Wave 10
has since built the seventeen reports themselves — see «Wave 10» below.
Wave 9 has since supplied the missing half — committed cost, cost to complete and the forecast margin —
and the Wave 9 section below records what it took to make the margin a number the cockpit may print.

Wave 8 also closes the two links Wave 6 and Wave 7 deliberately left open: an RFI's "linked variation /
change order" is `aec_variations.rfi_id` (the reference is owned by the later record, so the RFI never
grew a column pointing at a table that did not exist), and a day's or an inspection's "cost impact" is
the variation's own `cost_impact_rial`, which is why neither the site log nor the issue grew one.

## Wave 9 — procurement (implemented, migration 0201)

§18's chain, end to end: Requirement → Material Request → RFQ → Supplier Quotations → Comparison →
Approval → Purchase Commitment → Delivery, and then the invoice, which is Accounting's.

What shipped:

| Surface | Change |
|---|---|
| Domain | `migrations/0201_aec_procurement.sql` — eight tables: `aec_material_requests` with `aec_material_request_lines` (the requirement and its scope), `aec_rfqs` with `aec_rfq_suppliers` (the enquiry and who was invited), `aec_supplier_quotations` (what came back, one row per supplier per RFQ, with the award link back to the comparison), `aec_commitments` (one register for both §18 endings, `kind IN ('purchase','subcontract')`) with `aec_commitment_deliveries` (what arrived, when, who received it), and `aec_procurement_events` (§33's trail for all five subjects). All eight ENABLE + FORCE RLS with a `tenant_isolation` policy and `UNIQUE (business_id, id)` for the composite keys; `workspace_documents` gains nullable `commitment_id` so a delivery photo is the same `workspace_documents` row every other register uses; `workspace_approvals.subject_type` widens with `material_request` and `commitment` and `workspace_activity.subject_type` with the same two; the migration seeds §22's «تأخیر تأمین» widget for the industry |
| Numbering | `src/lib/aec-numbering.ts` — one `nextAecNumber(table, projectId, prefix)` under `pg_advisory_xact_lock`, with the four prefixes `MR-`, `RFQ-`, `PO-` and `SC-`. Numbers are unique per project and per kind, and deliberately **not gapless**: a deleted draft returns its number, which the suite asserts instead of papering over |
| Immutability | Five guards make §33's history a property of the schema rather than a promise in a service: a submitted material request is frozen (reject it to revise it) and only a draft may be deleted; an issued RFQ is frozen while the suppliers are quoting it; a decided quotation is history; a submitted commitment is frozen, and a **delivered** one has exactly one move left — closing it out, which is where the invoice becomes Accounting's business (every other change to a delivered award is refused). The commitment's deliveries belong to an approved award and become history with it |
| Ownership | `aec_assert_procurement_references_owned()` refuses a row whose project, party, BOQ item or receipt disagrees with its tenant — the same shape Wave 2/4 established, and the reason a cross-project `request_id` or a foreign party is a `23514` from the database and a named code (`project_not_found`, `party_not_found`, `request_not_found`, …) from the service |
| Pure half | `src/lib/aec-procurement.ts` — §18's six material-request statuses, four RFQ statuses, four quotation statuses and seven commitment statuses with their chains and their deliberate reopenings (`rejected → draft`), the four priorities, both kinds with their prefixes and `COMMITMENT_CAPABILITY_FOR`; `commitmentTotals`, `commitmentDelayDays`, `isCommitmentDelayed` (the one delay predicate the tab, the widget, the scan and the assistant share), `costForecast`, `forecastMarginRial` and `FORECAST_BASIS_LABEL`; every action catalogue with its labels, its past-tense labels and its events, and one predicate each — `materialRequestActionNeedsApproval` and `commitmentActionNeedsApproval` |
| Service | `src/lib/aec-procurement-service.ts` — request, RFQ, quotation, commitment and delivery CRUD with their preconditions, `applyMaterialRequestAction`/`applyRfqAction`/`applyQuotationAction`/`applyCommitmentAction`, the two queue halves `decideMaterialRequestApproval`/`decideCommitmentApproval`, `recordDelivery`, and the four reads the cockpit, the widgets, the scan and the assistant share: `projectCommitmentTotals`, `projectProcurementSummary`, `delayedCommitments`, `pendingMaterialRequests` |
| API | Fifteen route files under `/api/aec`: `GET/POST` for a project's `requests`, `rfqs` and `commitments` plus the aggregate `GET /api/aec/projects/[id]/procurement`; `GET/PATCH/DELETE` and `POST …/status` for `requests/[id]`, `rfqs/[id]`, `quotations/[id]` and `commitments/[id]`; `GET/POST /api/aec/rfqs/[id]/quotations`; `GET/POST /api/aec/commitments/[id]/deliveries`; and `DELETE /api/aec/deliveries/[id]` (a receipt is deleted, never edited). Every one `withTenantScope` + `aecOwner` + `requireProjectCapability` |
| Permission | **No new key.** Reading is `workspace.view`; writing the registers is `workspace.manage`; approving a request or an award is `workspace.approve` — §24's "procurement manage" expressed through the two keys the product already has, with the split asserted per route in `api-guards.test.ts` |
| Capabilities | `procurement` and `subcontractors` join `AEC_LIVE_CAPABILITIES` (twelve live keys). §18's "small architecture offices should be able to disable/hide this entire capability" is the settings panel's existing switch, and the design presets already have procurement off. `subcontractors` gates the subcontract half of the register (and the subcontractor role in the participant catalogue) independently, so a fit-out contractor that buys materials but employs its own crews switches the second one off alone. `material_tracking` stays reserved: delivery tracking is `procurement`, and a materials ledger would need the stock model an AEC tenant deliberately does not have |
| Screens | `src/app/(app)/workspace/projects/[id]/procurement-panel.tsx` («تأمین کالا») — a KPI row (committed, delivered, delayed), three registers (requests, RFQs with their quotation comparison and «ثبت تعهد از این پیشنهاد», commitments with their deliveries), detail overlays and the §33 trail, all with Shamsi dates and rial formatting through the shared workspace UI. Mounted in the project cockpit behind the capability, in the tab order `… finance → procurement → changes → payments`, because the award is what the change order then argues about |
| §20 roll-up | `getProjectCommercialSummary` now reads the wave's registers: committed cost, delivered cost, the delayed count and their rial, cost to complete, forecast final cost and the forecast margin — `COMMERCIAL_AWAITING_WAVES` is **empty**, and the cockpit prints the method (`FORECAST_BASIS_LABEL`) under the figure. The forecast returns `null`, never zero, when the ledger or the approved estimate is unreadable; the margin widget stays deliberately unseeded until somebody can see that basis on screen, which is what the panel now shows |
| Assistant | `list_procurement_delays` — §23's eleventh AEC read and §22's "Procurement Delays": the late awards with their supplier, project and days late, plus the pending requests and the §20 figures. Wired on all six AI surfaces (`ai.ts`, `ai-capabilities.ts`, `mcp/tools.ts`, `aec.ts`, `aec-ai-tools.ts` and its suite) |
| Notifications | `aec.procurement_delivery_delay` on the **existing** hourly AEC sweep — an approved award past its promised delivery date, deduped per award per day through `notificationDedupeKey`, `important`, owner/manager, with `MAX_OVERDUE_PER_SCAN` as the per-scan budget so a hundred late boxes cannot silence the one that matters |
| Party merge | The three supplier columns are classified in `PARTY_REFERENCES`: `aec_rfq_suppliers.party_id` and `aec_commitments.supplier_party_id` move while the row is a draft, `aec_supplier_quotations.party_id` while the quotation is undecided — which is exactly what the guards freeze, so a merge and the schema agree. `integration/party-merge-coverage.integration.test.ts` derives its coverage from PostgreSQL and passes |
| Isolation | `integration/aec-procurement.integration.test.ts` (10 tests) runs against a real database: numbering for all four prefixes, approval once, the quotation comparison and its cross-tenant party refusal, both commitment-submission refusals, the committed/delivered/closed roll-ups without double-counting the ledger, the event trail, the subcontractor capability override, cross-project ownership, the §20 forecast and margin, the delay scan with its dedupe, and a per-table RLS sweep (row present for the owner, `relrowsecurity AND relforcerowsecurity`, one `pg_policies` row each) plus service-level refusals for a foreign tenant. `integration/aec.integration.test.ts`'s sweep now walks all eight new tables |

### Decision 27 — a supplier is a `parties` row, and the flow stops where the ledger starts

§18 could be read as an invitation to build a supplier master and a purchasing ledger, and the repo
already has both — for the trades that sell goods: `suppliers`, `purchases`, `purchase_items` and
`inventory_items`, all `location_id`-scoped. An AEC tenant has no products workspace and no location,
so those tables are unreachable for it, and duplicating them inside procurement would create a second
supplier identity next to CRM's. So a supplier stays a `parties` row (as the issue's own boundary says:
"suppliers remain `parties`"), reached through the same party picker the participants tab uses, its
merge handled by the existing registry — this wave only adds the three columns that point at it. The
same restraint ends the flow: no table here has a paid, invoiced or received balance, and the last
status of an award is `closed`, which is precisely the moment the invoice and the payment become
Accounting's business. The cockpit's actual cost is still read from the ledger, and the wave's numbers
are the ones the registers own — committed, delivered, delayed, forecast.

### Decision 28 — the approval is the award, and the queue already has the two buttons

§18's chain names one Approval step between the comparison and the commitment, and the shape that
suggests — a general "procurement approvals" screen — would be a second approval mechanism next to
`workspace_approvals`. Instead the wave adds two *subjects* to the queue that exists (`material_request`
and `commitment`), and the decision in the inbox moves the register: approving a commitment is what
turns a chosen quotation into a Purchase Commitment, and rejecting a request is what sends it back to
draft so it can be revised. There is no review state in these two chains, so unlike Wave 8's decision
(Decision 24) the queue applies the transition directly — the difference is the chain, not the
mechanism. `api-guards.test.ts` asserts the route split, and the database suite asserts that a second
decision on the same subject is refused rather than silently repeated.

### Decision 29 — delivery is a fact about a box, not a status of the award

A delivery row is evidence that something arrived; the award's status is a decision that the
commitment is complete. Conflating them looks convenient — record a receipt, the award flips to
`delivered` — and it quietly turns a note about a box into a financial fact. So `recordDelivery` never
touches the award's status: the award moves to `delivered` when somebody takes that act
(`applyCommitmentAction(…, 'deliver')`), and §20's `deliveredRial` counts exactly those awards, which
is why the suite asserts the figure stays at zero after a receipt and moves after the act. The delay
warning follows the same rule from the other side: only an *approved* award can be late (a delivered
one is no longer waiting), and `commitmentDelayDays` is one predicate the tab, the §22 widget, the §29
scan and §23's assistant all call, so no two screens can disagree about which box is late.

### Decision 30 — a forecast must say what it is made of

§20 asks for committed cost, cost to complete, forecast final cost and the project margin, and the
margin is the number a contractor will make a decision with. The temptation is a single figure
computed by whatever formula happens to be nearest. Instead the method is written down and displayed:
what has been spent (the ledger), what has been committed (this wave's awards) and what is left of the
approved estimate covers the rest, with `costToCompleteRial` clamped at zero and `FORECAST_BASIS_LABEL`
printed under the figure in both the cockpit and the assistant's answer. And the forecast returns
`null` — never zero — whenever a half of the arithmetic is unknown (no approved estimate, or an actor
without `ledger.view`): a number built on a missing half is a guess wearing a number. That is also why
`COMMERCIAL_AWAITING_WAVES` can now be empty and the «Project Margin» widget is *still* not seeded:
the wave that supplied the arithmetic also had to supply the sentence that explains it, and the
cockpit shows it.

### Decision 31 — two switches, not one, because subcontracted work is a different business decision

§18 asks for one switch — a small architecture office hides procurement entirely — and the wave
provides two, because they answer two questions: «do we buy materials and services on this project?»
(`procurement`) and «do we hand work to subcontractors?» (`subcontractors`). The commitment register
carries both endings, and `COMMITMENT_CAPABILITY_FOR` decides which key each kind needs — so a fit-out
contractor that buys materials but employs its own crews turns the subcontract half off without losing
the purchase register, and `subcontractors` keeps its second job of gating the subcontractor role in
the participant catalogue. The database suite proves the split on one fixture: with
`capabilityOverrides` switching `subcontractors` off, saving the profile drops it from the resolved
capabilities and the subcontract path refuses with `capability_disabled`, not with a 403 about
permissions. An override only works when the key is spelled right, which is exactly the bug that first
made this test pass for the wrong reason (`overrides` was silently ignored) — the lesson is in the
service's own signature, not in a comment.

### Decision 32 — a shared trigger must not read a column in its first condition

`aec_assert_procurement_references_owned()` serves eight tables with different columns, so it branches
on which table it is running for before reading anything. Its first version read `NEW.created_by` in
those branch conditions — the same columns the branch *bodies* legitimately use — and PL/pgSQL
resolved them when it executed the condition rather than after the branch was chosen, so the trigger
that fired for `aec_material_request_lines` (a table with no `created_by`) died with
`record "new" has no field "created_by"` even though the branch it belonged to never read the column.
The fix is one line of discipline for any future shared trigger: declare
`payload jsonb := to_jsonb(NEW)` and compare `payload ->> 'col'` in the conditions, keeping `NEW.col`
in the bodies. The same migration also learned a lesson about late statuses: its commitment guard
originally froze a delivered award completely, which made §18's chain unwalkable past delivery — a
delivered award may now move to `closed` (and only that), and the suite that walks the chain end to end
is what caught it.

## Wave 10 — AI, reporting and mobile/offline (implemented in part)

The issue's own sentence for this wave is "tools, recommended widgets, reports, sync classification,
UX hardening". §30's report set shipped first because it is the half that needs no new storage: every
entry reads a register an earlier wave already owns.

### §30's report set (implemented)

What shipped:

| Surface | Change |
|---|---|
| Catalogue | `src/lib/aec-reports.ts` — §30's seventeen reports in the issue's own order (`project_health`, `schedule_variance`, `budget_vs_actual`, `committed_vs_budget`, `forecast_final_cost`, `project_margin`, `boq_variance`, `change_order_exposure`, `procurement_delay`, `rfi_aging`, `submittal_aging`, `document_status`, `contractor_performance`, `site_productivity`, `snag_aging`, `inspection_status`, `certificate_status`). Each entry carries the capability that has to be on (`null` for the three that every profile has — health, schedule variance, RFI aging), its Persian label and description, its columns with a `kind` (`text`/`number`/`money`/`date`/`percent`/`status`) so the screen formats by kind rather than by guessing, its empty message and its §34 note, and `AEC_REPORT_AI_TOOL`: the §23 read that answers the same question, typed `Partial<Record<AecReportKey, AecAiToolName>>` so a key that names a tool the assistant does not have fails the type check. Two shared vocabularies live here too: `reportsForCapabilities` (the gate) and the aging buckets (`AEC_AGING_BUCKET_LABELS` with `agingBucket`/`reportAgeDays`/`reportPercent`) that the RFI, submittal, snag, change-order and delay reports all speak |
| Service | `src/lib/aec-reports-service.ts` — `projectAecReports(owner, projectId)` returns `AecReportBundle` (project, the business's own today, the capabilities, the reports) and reads each *group* once rather than each report: §20's commercial summary answers the four financial reports, the commitment register answers the delay and the supplier tables, the drawings register answers the document and the submittal reports. Three reads are new SQL because no register prints them — the phase/task variance (with a «بدون فاز» row, so a project that runs without phases does not understate its schedule), the supplier performance table and the quality counts — and each uses the register's own predicate (an award counts from `approved` through `delivered`/`closed`; a site issue is open while it is not closed or cancelled). Financial figures are never recomputed: actual cost is `projectReport`'s ledger read (`null` without `ledger.view`), the forecast is §20's `costForecast` with `forecastBasis` printed under it. `AEC_REPORT_ROW_LIMIT = 25` keeps a report a screen rather than an export: the worst rows print and `omittedRows` says how many did not, with the register named as where the rest lives |
| API | `src/app/api/aec/projects/[id]/reports/route.ts` — `GET` behind `withTenantScope` + `aecOwner(PERMISSIONS.workspaceView)` + `requireProjectCapability(owner, id, "view")` + `handleAecError`, the same four gates every other AEC aggregate uses. The project is asserted once, up front, so another tenant's id is `project_not_found` rather than a page of empty reports that hides a typo. No `?key=` narrowing: a bundle is small and a page that asked for one report at a time would issue a dozen round trips |
| Screen | `src/app/(app)/workspace/projects/[id]/reports-panel.tsx` — the «گزارش‌ها» tab: a §30 KPI row (budget basis, posted cost, forecast final cost, delayed commitments), then one card per report with its totals line, its table through the shared `DataTable` + `stackedTableClass`, every cell rendered by `kind` (`useMoney()` for rials, `DateCell` for Shamsi dates, `StatusBadge` for statuses) and the assistant read that answers the same question named under the title — §34's "summaries with transparent source links". A report whose capability is off is not rendered at all, and the panel explains that in one sentence when the business has no reports to show |
| Cockpit | `src/lib/aec-cockpit.ts` — a `reports` section (Wave 10, shipped) between «صورت‌وضعیت‌ها» and «تیم», `AEC_SHIPPED_WAVE = 10`, and its own tab in `aecProjectTabs`, so an AEC project's bar ends `… finance → procurement → changes → payments → reports → team` |
| Permission | **No new key.** Reading a report is the same `workspace.view` the cockpit needs, writing nothing is possible (a report prints approvals, it does not grant them), and the two figures the books own stay behind `ledger.view` — with the row's value `null` rather than a zero the reader would believe |
| Isolation | `integration/aec-reports.integration.test.ts` (6 tests) against a real database: the bundle's keys equal `reportsForCapabilities`'s exactly and in §30's order; every figure is asserted against the register that owns it (the phase's overdue tasks, the ledger's actual cost, §18's late award, the RFI/submittal/snag ages and their buckets, the site log's crew and incidents, the certified claim); the design preset's switched-off capabilities leave eight reports **absent** while the design office still reads its own seven; an actor without `ledger.view` gets `null` where the ledger would be; another tenant's project is `project_not_found` and none of its rows reach my project's bundle; an F&B business is refused with `industry_mismatch`; and a thirty-row register prints `AEC_REPORT_ROW_LIMIT` rows with `omittedRows` saying how many stayed behind. `src/lib/aec-reports.test.ts` (8 tests) proves the pure half, and `api-guards.test.ts` asserts the route's permission shape from its source |

### §26's deployment-mode classification (implemented)

§26 asks for an audit rather than for replication: *"Audit all new entities for
deployment-mode behavior … Classify each new entity … If new entities are
replicated, update [the replication catalogue, sync registry, pairing snapshot,
drift checks, desktop bootstrap, sync tests, conflict behavior]."*

| Surface | Change |
|---|---|
| Classification | `src/lib/aec-sync-classification.ts` — every AEC table in one of §26's buckets, with what a future protocol must add first. **Field-capture candidates** (§26's own eleven: tasks, checklists, site logs, site-photo metadata, inspections, snag lists, daily progress, document and drawing metadata, RFI drafts, submittal review drafts) carry the *boundary* that may ever travel — a draft, never a frozen row — because each register's guard freezes the submitted half; **financial/high-risk** (BOQ and estimates, variations, certificates, procurement, transmittals) carry `offlineBoundary: null` and the reason §26 gives them: a commitment, a certificate or a variation is a status machine whose terminal states move money, and a field-by-field merge could produce the very states their triggers refuse. `aecSyncClassificationProblems(schemaTables)` is the audit's own guard (an unclassified table, or a claim without a table), and `AEC_SYNC_ISSUE_OFFLINE_CANDIDATES` maps §26's own words onto the entries |
| Contract | `src/lib/data-ownership.ts` gains `aec_field_capture` and `aec_commercial_registers` as `not_replicated` / `transport: "none"` domains — the machine-readable contract pairing disclosure, diagnostics and docs already consume — and `src/lib/replication-catalogue.ts` gains the matching cloud-only domains, so the pairing screen names the AEC registers as central-only instead of staying silent about them. `pairing-service.ts`'s coverage copy says it in one English sentence the operator and the desktop both read |
| Proof | `integration/aec-sync-classification.integration.test.ts` (3 tests): the schema's own table list has no unclassified AEC table and the classification claims nothing the schema lacks; **no classified table carries `trg_sync_capture`** (with a control assertion that the same query finds it on `parties` and `menu_items`); and a pairing round trip into a **second database** leaves that database with the business and its chart of accounts and **zero rows in every AEC table** — §26's "do not silently create cloud-only AEC workflows where the desktop expects operational continuity", answered by showing the desktop has none to lose. `src/lib/aec-sync-classification.test.ts` (7 tests) is the pure half |

### Decision 33 — a report reads the register, it never recomputes it

§30's last sentence ("financial amounts must use Accounting as the source where they represent posted
financial facts") is the whole design. The service computes no money: the actual cost is the ledger's
read through `projectReport`, the estimate and the revised contract value are §20's, the forecast is
§20's `costForecast` with its basis printed, and the register figures — delays, exposure, ages, counts
— come from the predicates the registers themselves use. Where §30 asks a question no register prints
(supplier performance, quality counts by kind, the phase/task variance) the service adds one query
over the *same tables with the same predicates* rather than a materialised copy, so a report and the
tab it summarises cannot drift; and where the books answer (actual cost without `ledger.view`) the
cell is `null` — the screen prints «—» and says the ledger is unreadable, never `0`.

### Decision 34 — a switched-off capability is absent, never empty

`reportsForCapabilities` runs *before* the first query, so an architecture office that switched
`procurement`, `boq`, `variations`, `site_operations`, `qa_qc`, `snagging` and `progress_claims` off
gets nine reports instead of seventeen — not nine plus eight empty cards, and not eight queries the
business does not want. This is §21's rule the rest of the module already follows (an unbuilt or
switched-off section is absent, never greyed out), and it is why §30's list is expressed as
capability-tagged catalogue entries rather than a screen with sections hidden by CSS. §34's "cockpit
over giant tables" is the other half: each report prints its worst twenty-five rows and names the
register where the full list lives.

### Decision 35 — one aging vocabulary, shared by five reports

"RFI aging", "submittal aging", "snag aging", "procurement delay" and "change-order exposure" are
five registers asking the same question — how long has this been waiting, and how bad is that. They
answer it through one `agingBucket` (بهموقع / تا ۱۴ روز / تا ۳۰ روز / بیش از ۳۰ روز) and one
`reportAgeDays`, both measured against the business's own today (`businessToday`), never the server's
date and never a second definition of "late". A report that invented its own thresholds would be the
one screen where the RFI tab and the report disagree about the same RFI.

### Decision 36 — a classification is a decision with a reason, not a missing entry

An entity that is not in the sync catalogue looks exactly like an entity that was
forgotten. §26 asks for the difference to be written down, so every AEC table
names its bucket, the write model that put it there (`append_fact`,
`signed_record`, `state_machine`, `derived_by_register`), the conflict rule that
*would* apply, and the things a protocol must add before the bucket changes —
server-side numbering, an event key, the register's freeze boundary. The
financial registers say `null` for "what may travel" rather than an empty string,
and the database suite proves the second half of the claim (§26's "do not simply
put transactional commercial/accounting operations into generic last-write-wins
master-data sync") by asserting the capture trigger is absent from all of them.

## The parts of Waves 10–11 not built yet

In the issue's order. Nothing below has a migration or a screen yet; the wave boundaries exist so each
can be reviewed on its own.

10. **What Wave 10 still owns.** §25's **mobile/field flows** and §34's UX hardening on top of them
    (the report set, §22's widgets and §26's classification are built; the platform console's
    «ویجت‌های پیشنهادی» page administers the recommendations without touching a member's own
    widgets).
11. **Cleanup.** The repo-wide audit of hard-coded industry arrays, routes that assume every
    non-F&B tenant is retail, dead routes and duplicate project/financial logic.

Wave 6 leaves two issue items to the waves that own them, deliberately: an RFI's "linked variation /
change order" (§10) is a field on the *variation*, which Wave 8 builds — the link is owned by the
later record, so the RFI does not grow a column pointing at a table that does not exist yet; and an
"RFI draft"/"submittal review draft" being a good offline candidate (§26) is a replication-domain
decision, which belongs with that classification rather than with this register. The §25 mobile flows
(create RFI, review submittal) are the same service and the same endpoints the desktop screens call,
so they need no AEC work of their own — Wave 10 owns the offline storage, and its report set is now
built (see «Wave 10» below).

The "non-F&B ⇒ retail" assumption in the WooCommerce/CMS ingest paths
(`integrations/sync-service.ts`, `integrations/outbox-service.ts`, `cms/order-ingest-service.ts`,
`integrations/webhook-ingest-service.ts`) is knowingly left in place for Wave 11: those branches
read `items`/`item_stock`, which an AEC tenant cannot create (the products workspace is gated to
the five trade-goods industries), so the path is unreachable rather than wrong. Wave 11 turns that
"not a café" test into an explicit stock-model question so the next trade cannot inherit it by
accident.
