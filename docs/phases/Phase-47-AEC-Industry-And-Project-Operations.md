# Phase 47 — The AEC industry and AEC project operations

**Status:** Waves 1–3 implemented (migrations 0193, 0194, 0195); Waves 4–11 designed here, not built.

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

## Waves 6–11 — designed, not built

In the issue's order. Nothing below has a migration or a screen yet; the wave boundaries exist so
each can be reviewed on its own.

6. **RFIs and submittals.**
7. **Site execution.** Daily logs, inspections, QA/QC, NCRs and snagging.
8. **Commercial controls.** Variations/change orders, progress certificates, retention and advance,
   and the project commercial cockpit.
9. **Procurement.** Requests, RFQs, comparison, approvals and delivery tracking.
10. **AI, reporting and mobile/offline.** AEC tools and widgets on the existing assistant, the AEC
    report set, and the hybrid/offline classification.
11. **Cleanup.** The repo-wide audit of hard-coded industry arrays, routes that assume every
    non-F&B tenant is retail, dead routes and duplicate project/financial logic.

The "non-F&B ⇒ retail" assumption in the WooCommerce/CMS ingest paths
(`integrations/sync-service.ts`, `integrations/outbox-service.ts`, `cms/order-ingest-service.ts`,
`integrations/webhook-ingest-service.ts`) is knowingly left in place for Wave 11: those branches
read `items`/`item_stock`, which an AEC tenant cannot create (the products workspace is gated to
the five trade-goods industries), so the path is unreachable rather than wrong. Wave 11 turns that
"not a café" test into an explicit stock-model question so the next trade cannot inherit it by
accident.
