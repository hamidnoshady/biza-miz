# Phase 47 — The AEC industry and AEC project operations

**Status:** Waves 1–2 implemented (migrations 0193, 0194); Waves 3–11 designed here, not built.

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

## Waves 3–11 — designed, not built

In the issue's order. Nothing below has a migration or a screen yet; the wave boundaries exist so
each can be reviewed on its own.

3. **AEC Workspace UX + templates.** The project cockpit and overview widgets (projects at risk,
   delayed milestones, pending approvals, contract and guarantee expiries, budget vs actual,
   outstanding certificates, today's site activity) and the built-in project templates
   (Architecture Design, Civil/Structural, General Contractor, Design & Build, Interior/Renovation,
   Consulting/Supervision) alongside tenant-created ones.
4. **BOQ and estimating.** Estimate → version → BOQ section → item → rate breakdown, the
   Draft/Submitted/Under Review/Approved/Superseded status model with immutable approved history,
   and Excel/CSV import through the existing data-transfer engine (preview, mapping, validation,
   row errors, safe import) — never a second import architecture.
5. **Document control.** Drawing numbers, revisions, issue purposes and transmittals over the
   existing media library and project documents.
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
