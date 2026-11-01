# Issue #1128 — Advertising Agency business type (آژانس تبلیغاتی)

**Status of this change:** Waves 1, 2 and 3, plus three merges of `main`. The first gave wave 2
something to bill with. The second (#1171 and a desktop bump) and the third (#1174, one
effective-access resolver) both landed while wave 3 was in CI, and both touched only the generated
MCP matrix among this branch's files — so each conflict was resolved by regenerating both artifacts
from the merged source rather than hand-merging a diff of generated text. #1174 matters beyond that:
it rewrote the access resolver `agencyOwner` delegates to, so the merge was gated on the whole suite
and the type check rather than on the merge reporting clean.

*Wave 1* is the industry foundation: registry, migration, chart of accounts and profile, plus the
posting/report wiring those four cannot be separated from, and the tests and CI guard that hold them
in place.

*Wave 2* is the agency's own starting points: the eight operating profiles as one stored preset
(`src/lib/agency.ts`, the settings form, `PUT /api/settings/agency-profile`), the seven project
blueprints §B lists (`src/lib/workspace-agency-templates.ts`), and the sidebar contract test the P0
checklist asked for (`src/lib/tenant-navigation.test.ts`).

*The merge* is `main`'s `2707a540` ("Add a service invoice for contracting and service trades",
issue #799) meeting wave 1's decision 8. The agency now carries `pos` as the address of that screen,
is the third trade in `SERVICE_INVOICE_INDUSTRIES`, and writes invoice lines that credit its own four
revenue accounts — so §D's ordinary sale document is in this change. The documents around it were
not, at that point; wave 3 added most of them, and what remains is named in «What this change does
not build». Decision 8 records the change of mind and why the earlier answer was wrong.

*Wave 3* is §D's billing documents — the ones that decide what an agency asks a client for, and
when. Two registers, both scoped to a project: `agency_billing_milestones` (a deposit, a delivery
stage, a retainer period or a final settlement, priced as a percentage of the engagement or as a
fixed amount) and `agency_change_requests` (what altered the engagement after the client agreed to
it, signed so a descope is a negative figure rather than a second column), in migration 0260. Around
them: `src/lib/agency-commercial.ts`, a pure module that owns both status chains, the acts each
status offers and who may take them, the schedule splits and the percentage arithmetic;
`src/lib/agency-commercial-service.ts`, which writes them and reads §D's project P&L; seven routes
under `/api/agency/**` behind one guard; both subjects wired into the shared approvals queue; the
one-line change that lets a service invoice's journal entry carry the project it bills, which is
what makes the P&L's posted half a single read; and the billing card on the project's «مالی» tab.

Working issue: [#1128 — [Feature][Business Type] Advertising Agency — agency projects, campaigns,
clients, billing & approvals](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/1128).

## Scope note

#1128 is a multi-wave epic: P0 is the first-class business type, P1 is the agency-ready baseline
built on CRM, My Workspace, Accounting and Growth, P2 is attribution, resource analytics and
approval-gated automation. `docs/plans/ISSUE_INDEX.md` names the first step exactly — *"Registry,
migration, chart, profile"* — and that is what this change is.

After it, an Advertising Agency tenant can be created from `/welcome`, from the platform console's
provision dialog and from `POST /api/platform/businesses`; it is stored as `advertising_agency`
(the CHECK constraint admits it), seeded with its own 85-account chart, given its own profile,
nouns and brand block, walked through the `service` setup shape, and refused — by module guard and
by family — everywhere the app would otherwise assume a counter or a goods catalogue. What it can do
is bill: its invoice lines are described services (`service-invoice.ts`), the same document the other
two service trades write.

Wave 2 adds what an agency *starts from*: an owner picks which of the eight shapes the business
works as in «تنظیمات ← کسب‌وکار و شعبه», and My Workspace then offers that trade seven agency
blueprints — brand identity, website/landing page, monthly social retainer, search/social ad
campaign, outdoor & print campaign, video production, PR/event — with the ones its preset
recommends badged «پیشنهادی» and listed first.

What it is **not** yet is the agency experience §A–§F of the issue describes: the pipeline, the
billing modes, the campaign P&L, the review links and the dashboards. That is the point of the
split, and it is the same split #799 (AEC) and #839 (automotive) made: the trade exists and is
honest about what it has, and the workflows land on top of it in later waves rather than the other
way round. See «What this change does not build».

## What shipped

| Surface | Change |
|---|---|
| Registry | `advertising_agency` in `src/lib/industries.ts`, label «آژانس تبلیغاتی» (English *Advertising Agency*; «کانون تبلیغاتی» is recorded as the alternative copy, not as a second key), enabled in `ENABLED_INDUSTRIES` so `/welcome`, the platform picker and the provision dialog offer it |
| Family | `industryFamily("advertising_agency") === "service"`, so `hasSellableCatalogue` is false: product sync skips its site's "products" and a storefront order is refused as `industry_not_storefront` instead of being written as a retail sale |
| Database | `migrations/0259_advertising_agency_industry.sql` widens `businesses_industry_check` to twelve values — additive, idempotent, no new tables, no backfill, no feature-flag rows |
| Chart of accounts | `ADVERTISING_AGENCY_COA_TEMPLATE` (85 accounts: 21 asset, 20 liability, 7 equity, 13 revenue, 24 expense) — four service revenues, four direct client-cost accounts as cost of sales, a reimbursable client-cost receivable, unbilled project work, and a media/production payable |
| Profile | `INDUSTRY_PROFILES.advertising_agency` — brand «آژانس تبلیغاتی» / «مدیریت مشتری، پروژه، کمپین و امور مالی», `[...CORE_MODULES, "pos"]` (`pos` being the address of the invoice screen — see decision 8), its own nouns (`AGENCY_LABELS`), `salesModel: retail_invoice`, restaurant-shaped flags seeded off, no capability |
| Setup wizard | `SETUP_SHAPE.advertising_agency = "service"` — business → accounts → tax → users → hardware → backup → opening; no `costing`/`menu` pair, no AEC-style profile step, no catalogue pointer on the finish page |
| Posting/report wiring | `accounting-posting-rules.ts` (inventory 1300, revenue 4640 with the other three named in the note, and where client media cost sits), `retail-stock-posting-rules.ts`, `retail-account-codes.ts`, `retail-invoice-service.ts` (`LINE_KINDS_BY_INDUSTRY` → `["service"]`), `coa-template.ts`'s cost-of-sales list, and `account-classification.ts`'s 214x block |
| Operator warning | `industrySwitchCautions` now says out loud when a switch *removes the counter*: a catalogue trade turned into a service or project one keeps its stock rows and loses the ability to sell them |
| Tests | New blocks in `coa-template.test.ts`, `industry-profile.test.ts`, `wizard-steps.test.ts`, `accounting-posting-rules.test.ts`, `industries.test.ts`, `account-classification.test.ts`, `industry-coverage.test.ts`, and four real-database cases in `integration/business-industry.integration.test.ts` |
| **Wave 2** — operating profiles | `src/lib/agency.ts`: the eight presets the issue names, their Persian labels and descriptions, the `full_service` default, a guard for values that come from the database or a request body, and a defensive reader for the stored jsonb. No permission, role or capability anywhere in the module — asserted by a source scan in `agency.test.ts` |
| **Wave 2** — storage | `SETTING_KEYS.agencyProfile` (`agency.profile`) in the shared key/value `settings` table: one business-wide jsonb value, no migration, no table, nothing for an existing tenant to lose. `src/lib/agency-service.ts` reads and saves it inside the tenant scope, refuses another industry with `industry_mismatch` and an unknown preset with `invalid_profile`, and writes an `audit_log` row in the same transaction |
| **Wave 2** — blueprints | `src/lib/workspace-agency-templates.ts`: §B's seven sequences as code, scoped to `advertising_agency`, each keeping an internal review before the client sees the work and an explicit client approval before publication. Merged into `BUILTIN_TEMPLATES` beside AEC's six |
| **Wave 2** — presets × blueprints | `WorkspaceOperatingProfile` is now the union of AEC's eight and the agency's eight; a template's `recommendedProfiles` and `templatesForIndustry`'s ordering take it, and `/api/workspace/templates` resolves whichever reader answers for the tenant's industry. The vocabularies are asserted disjoint, so a crossed wire badges nothing rather than something arbitrary |
| **Wave 2** — the choice in the UI | `PUT/GET /api/settings/agency-profile` on `settings.manage`, and `AgencyProfileForm` rendered in the business settings section for this industry only — the same home and the same reasoning as `AecProfileForm`. The wizard stays seven steps: the issue allows a wizard step *or* tenant settings, and only settings keeps the `service` shape every service trade shares |
| **Wave 2** — audit copy | `settings.agency_profile.update` labeled in `audit.ts` from the start, so the audit tab shows «تغییر پروفایل فعالیت آژانس» and not a dotted key |
| **Wave 2** — tests | `src/lib/agency.test.ts` and `src/lib/tenant-navigation.test.ts` are new; `workspace-shared.test.ts`, `audit.test.ts` and `integration/business-industry.integration.test.ts` gained blocks |
| **Wave 2** — billing (§D's first document) | `main` had meanwhile shipped #799's service invoice, so the agency joins it rather than waiting for a wave of its own: `SERVICE_INVOICE_INDUSTRIES` and `SERVICE_REVENUE_ACCOUNTS` name the trade and its four revenue accounts (4640 default, 4650 creative, 4660 media, 4670 PR/events), the profile grants `pos` as the address of that screen, and the Accounting sidebar gains «فروش و درآمد» → «صورتحساب و دریافت». `ServiceLineForm`'s prop type became `ServiceInvoiceIndustry` so the third trade is not excluded by a hard-coded pair, and `industry-coverage.test.ts`'s `REGISTRY_SETS` gained the set |
| **Wave 3** — registers | `migrations/0260_agency_commercial_documents.sql`: `agency_billing_milestones` and `agency_change_requests`, both scoped to a project, both numbered per project (`MS-001`, `CR-001`) under the advisory lock `register-numbering.ts` already took for AEC's five registers. A milestone is a percentage **or** a fixed amount, never both and never neither; a change request's amount is signed and non-zero; a milestone's `revenue_code` must be one of the trade's four **and** must exist in the tenant's chart; an invoice pointer is `RESTRICT`, so recording "this was billed" cannot be deleted out from under the row. Submitted rows are frozen and terminal rows immutable by trigger, both tables carry shape-1 RLS, and nothing in the migration posts a journal entry |
| **Wave 3** — the pure module | `src/lib/agency-commercial.ts`: §D's four engagement bases as one vocabulary, the two status chains and their legal moves, the acts each status offers with the permission each needs, the schedule splits (`draftScheduleForBase`, `splitPercent`, `splitAmountRial` with the remainder on the last share), retainer periods, the revised-value arithmetic, and the P&L's booked/posted split with a margin that refuses to guess. It imports `./digits` and `./service-invoice` and nothing else — asserted by a source scan, because a module that decides who may approve a figure must not be able to reach a database |
| **Wave 3** — the service | `src/lib/agency-commercial-service.ts`: reads and writes both registers, lays a whole schedule out from a base in one transaction and one lock, resolves a percentage against the engagement's revised value at invoice time and never at rest, issues the invoice through `createRetailInvoice` inside the caller's transaction, and reads §D's project P&L — the booked half from the schedule, the posted half from `journal_entries.project_id`, actual cost included and never stored here |
| **Wave 3** — HTTP | `src/app/api/agency/guard.ts` plus seven routes: a project's commercial picture and the schedule laid out from its base; a milestone added, read, edited, deleted and moved along its chain; a change request raised, read, edited, deleted and moved along its. The owner gate is the *workspace* one, so a tenant whose projects service is deactivated cannot write a billing schedule through a different path, and the error map falls through to `handleWorkspaceError` so a project-gate refusal keeps its own status. Both subjects join the shared queue's dispatch door in `api/workspace/approvals/[id]/route.ts` |
| **Wave 3** — the project dimension | `CreateRetailInvoiceInput.projectId` → the `service.sale_revenue` domain-event payload → `service-posting-rules.ts` → `postExactJournalEntry`. Four small edits, and they are what put an invoice's own entry on the project P&L's single read instead of leaving it to be reconciled afterwards. All three service trades benefit, not only the agency |
| **Wave 3** — the screen | `src/app/(app)/workspace/projects/[id]/agency-billing-panel.tsx` in the project's «مالی» tab, mounted only when `/api/workspace/lookups` answers `agencyCommercial` — a new flag, absent rather than `false` for every other trade, so no project page has to call `/api/agency/**` to discover it is not an agency and render an `industry_mismatch` banner for the request |
| **Wave 3** — tests | `agency-commercial.test.ts` (43, pure), `api/agency/guard.test.ts` (7, including an exhaustive status table typed over the union so a new refusal code cannot silently default to 400), and `integration/agency-commercial.integration.test.ts` (17, real database: the schedule, the percentage resolved at invoice time, the posted entry and its project dimension, approving-without-billing, the self-approval refusal, and migration 0260's guards as database facts) |

| **Wave 4** — §E schema | `migrations/0265_media_client_review.sql`: four tables (`media_review_rounds`, `media_review_round_items`, `media_review_links`, `media_review_events`) and six triggers. Refs into §E's own tables are composite foreign keys; refs into the four shared tables (`media_assets`, `ai_projects`, `parties`, `growth_campaigns`) are trigger-validated, because none has `UNIQUE(business_id, id)` and `media_assets` stays untouched. `media_review_round_guard` is the state machine's backstop: DELETE only from `draft`, the whole row immutable once `approved`/`rejected`, title and scope frozen for `sent`/`withdrawn` with `note` still editable, and nothing frozen for `changes_requested`. Links are append-only except `revoked_at` and the use counters, events are append-only with no draft exception, `sent_at` is set once and never cleared, one live link per (round, purpose), sha-256 stored as 64 hex, TTL clamped 1–30 days. All additive, no backfill, and nothing in it posts a journal entry |
| **Wave 4** — the pure module | `src/lib/media-review.ts`: the round and item vocabularies, `REVIEW_ROUND_TRANSITIONS` with `canTransitionReviewRound` (two *statuses*, not a status and an act), the two freeze predicates, `reviewRoundStateFromItems` (null while anything is undecided; rejected outranks changes-requested outranks all-approved), the link purpose and TTL rules with revocation winning over expiry, the token's shape and display prefix, both act catalogues, and «۳ از ۵» progress. It imports `./digits` and nothing else — asserted by a source scan, because a module that decides what a client may do must not be able to reach a database |
| **Wave 4** — the service | `src/lib/media-review-service.ts`: 23 refusal codes, the round's whole lifecycle, items added/removed/relabelled/repositioned under a 50-item cap, links minted (plaintext returned exactly once) and revoked idempotently, and the client's three verbs. The security spine resolves a token once under a named `withoutTenantScope`, checks liveness with a reason, requires `sent`, then does everything else inside `withTenant` **plus an explicit `business_id` predicate** — 32 of them, because `withTenant` sets the RLS scope and never injects the column (decision 31). Approving a round requires every item decided and every item approved. Bytes are authorised separately from streaming so a 304 or 416 costs no storage read |
| **Wave 4** — HTTP (agency) | Seven routes under `/api/media/review-rounds/**` behind inline `requirePermission(PERMISSIONS.mediaView | mediaManage)`, so the static guard scan sees them: list, read, create, patch, transition (send/withdraw only), delete (draft only, writing `audit_log`), mint a link, revoke a link, and manage items. Revoke is a POST to `revoke`, not a DELETE, because it records an act rather than removing a row |
| **Wave 4** — HTTP (client) | Three routes under `/api/media/review/[token]/**`, added to `api-guards.test.ts`'s `PUBLIC_ROUTES` in the same commit as the routes (that test asserts every exemption key has a real file behind it). They are plain handlers with no session to require — the token *is* the guard — and they answer `Cache-Control: private, no-store`, unlike the tenant's own file route, because a token-bearing URL must never be cached. One error map in `src/app/api/media/review-guard.ts`, exhaustive over the 23 codes and pinned by a `Record<MediaReviewErrorCode, number>` in its test, so a new code without a status fails the compiler |
| **Wave 4** — the client screen | `/review/[token]`, public in exactly the way `/invite` is, plus its middleware entries. Renders each item's preview inline from its token-scoped URL, takes a per-item decision with a note, then a whole-round decision, and maps the refusal codes onto instructions split by whether the outcome is terminal or fixable. Its wire types are redeclared locally: the service imports the Postgres driver, and importing it into a client component would drag `pg` into the browser bundle |
| **Wave 4** — tests | `src/lib/media-review.test.ts` (42, pure), `src/app/api/media/review-guard.test.ts` (7, exhaustive status map), `integration/media-review.integration.test.ts` (18, real database), and 72 assertions against 0265 run directly over Postgres. Two MCP coverage rows were added and both generated matrices regenerated, because `media.assets`'s broad `routes: ["media"]` prefix silently absorbed all ten new route files — the only symptom was a stale route count |

| **Wave 5** — §A sales pipeline | `src/lib/crm-agency-pipeline.ts`: the agency's seven sales stages — intake, qualification, the brief, the proposal, scope and contract, won, lost — each with a probability, an outcome and its own exit criterion in `requirement_note`. No table, no entity, no engine: a list the platform's own `crm_pipeline_stages` already holds and `savePipelineStages` already validates. A type-only import and no `pg`, asserted by a source scan |
| **Wave 5** — §A wiring | `ensureAgencySalesPipeline` in `crm-pipeline-service.ts`, called from the two read routes where a member looks at pipelines: `GET /api/crm/pipelines` under `crm.configure` and `GET /api/crm/deals` under `crm.view`. Returns null and writes nothing for every other trade; inserts under `ON CONFLICT DO NOTHING` against `(business_id, name)`; writes `is_default` false so exactly one pipeline stays the default |
| **Wave 5** — §A tests | `crm-agency-pipeline.test.ts` (13, pure: both invariants `savePipelineStages` enforces, contiguous ordering, unique names within 120, notes within 300, probabilities rising to won, no legacy key, only the agency receives it, imports nothing but a type) and `integration/crm-agency-pipeline.integration.test.ts` (8, real database: beside-not-instead, idempotence, two simultaneous first visits, the default's identity and seeded six intact with zero deactivated stages anywhere, nothing written for a `jewelry` tenant, no legacy key, the invariants as rows, and a renamed stage surviving the next visit) |

| **Wave 6** — §A client briefs schema | `migrations/0274_agency_client_briefs.sql`: one table, `agency_client_briefs`. `party_id` is NOT NULL — a brief with no client is the agency guessing — while `deal_id` and `project_id` are nullable and `ON DELETE SET NULL`, because a brief is written against an opportunity, then carried by the project it becomes, and outlives either. The substance is columns rather than a jsonb blob (objective, audience, `channels text[]`, `deliverables jsonb`, `budget_rial`, dates, acceptance criteria) so it stays queryable and freezable. Two triggers: `agency_assert_brief_references_owned` validates the client, deal, project and approver against `business_id` and requires the approver to be *related to this brief's own client*; `agency_client_brief_guard` freezes the substance once confirmed, keeps `sent_at`/`confirmed_at` un-clearable, and allows a cascaded delete when the client itself is gone. Eight named CHECKs couple status to stamps. RLS shape 1, `ENABLE` + `FORCE`. Nothing in it posts a journal entry |
| **Wave 6** — §A brief vocabulary | `src/lib/agency-brief.ts`: five statuses, five acts, the chain between them, `agencyBriefActionsFrom` (which the panel renders its buttons from), the freeze/open/deletable predicates, a twelve-key channel vocabulary, and normalisers that return `null` rather than dropping a channel or deliverable nobody recognises — a silently vanished line item is a promise quietly unmade. Deliverable formats reuse §E's `AGENCY_MEDIA_FORMATS`, which already carried `brief`. Pure, so the panel may import it |
| **Wave 6** — §A brief service | `src/lib/agency-brief-service.ts`: fifteen refusal codes; list, read, create, patch, action, delete. Every statement carries its own `business_id` predicate (decision 31), and a PATCH tests `"field" in patch`, so omitting `budgetRial` does not clear the client's budget. Numbering is `nextBusinessRegisterNumber`, a business-scoped *sibling* added to `register-numbering.ts` rather than a change to `nextRegisterNumber`'s signature — seven registers call it positionally, and a brief has no project to scope by more often than it has one. Confirming attributes the confirmation to a name, falling back to the approver the brief already records |
| **Wave 6** — §A brief HTTP | Three routes under `/api/crm/briefs/**`, in the CRM door rather than the agency one (decision 39): list and draft, one brief and its edits, and the chain. `crm.view` to read, `crm.manage` to write and to move a brief along its chain, `crm.delete` to delete one. One error map in `src/app/api/crm/brief-guard.ts`, exhaustive over the fifteen codes. A new CRM section key `briefs` with its access row, its command-palette aliases, and its place in the «فرصت‌ها» group |
| **Wave 6** — §A brief screen | `/crm/briefs` and `briefs-section.tsx`. Acts are read off each row's own `actions`, so the screen never offers a button the route refuses (decision 30). The approver picker is populated from the chosen client's own relationships in both directions — exactly what 0274's trigger accepts — so another client's decision-maker is not among the options. A confirmed brief's sheet keeps only the note and the project pointer writable. Dates render through `formatJalali` and money through `formatPersianNumber`; the browser's own formatter is what `crm-rtl.test.ts` refuses |
| **Wave 6** — §A brief tests | `agency-brief.test.ts` (26, pure), `integration/agency-client-briefs.integration.test.ts` (17, real database) and 48 assertions against 0274 run directly over Postgres. The integration suite covers what only a database can show: one number sequence per agency held under a race, a second tenant unable to load, list, patch, transition or delete the first tenant's brief, §A's approver rule in both directions with nothing written on refusal, the freeze and the §A→§B handoff coexisting, and a client's deletion taking a confirmed brief with it |
| **Wave 7** — §A+§D proposal schema | `migrations/0276_agency_proposals.sql`: `agency_proposals` and `agency_proposal_lines`. One document for §A's "proposal/quote" and §D's "estimate", because §B's stage list puts them in one place (decision 43). The header stores `discount_rial` and `tax_rial` and no total (decision 44); each line carries `quantity numeric(14,3)`, a computed `amount_rial`, one of the trade's four revenue codes validated against the tenant's own chart, and the internal `cost_rial` + `pass_through` pair (decision 45). Four triggers: reference ownership including §A's stakeholder rule and the sharper one — a brief priced for a different client; the freeze from `sent` with its lines and the cascade-tolerant delete; the line guard that freezes with the price, refuses impossible inputs in words and then computes the amount; and the revenue account's chart check. `UNIQUE (business_id, id)` on both so a later register can composite-FK a line. `brief_id` is a simple FK because Postgres refuses `ON DELETE SET NULL` on a composite whose other column is NOT NULL. RLS shape 1 on both, `ENABLE` + `FORCE`. Nothing posts |
| **Wave 7** — §A proposal pure module | `src/lib/agency-proposal.ts`: the chain (`draft → sent → accepted|declined|expired|withdrawn`, with `withdrawn → draft` and every decision terminal), the actions derived from it, lapsing computed from the date rather than read from a status, line normalisation that renumbers in the caller's order and refuses rather than drops, the derived totals and the internal margin, and `agencyProposalClientView` — the projection in which `costRial` and `passThrough` do not exist as properties |
| **Wave 7** — §A proposal service | `src/lib/agency-proposal-service.ts`: fifteen refusal codes; list, read, create, patch, action, delete, plus `loadAgencyProposalClientView`. Header and lines are written in one transaction, because an offer is one statement about a price. Every statement carries its own `business_id` predicate, inside each of the six joins and the lateral aggregate too (decision 31). The list reads five figures from ONE lateral join rather than five correlated subqueries over the same rows, so its margin is real and its `costedLineCount` says whether it is complete. Two rules the database cannot enforce live here and are documented at the point of enforcement (decision 47) |
| **Wave 7** — §A proposal HTTP | Three routes under `/api/crm/proposals/**`, in the CRM door for the reason decision 39 gives, with one exhaustive error map in `src/app/api/crm/proposal-guard.ts` over fifteen codes plus the deliberate SQLSTATEs. A new CRM section key `proposals` with its access row, its command-palette aliases (including «پیش‌فاکتور» and «برآورد», the two other words for the same document), and its place in the «فرصت‌ها» group between the brief and the leads |
| **Wave 7** — §A proposal screen | `/crm/proposals` and `proposals-section.tsx`. حاشیهٔ سود is the central column, marked «ناقص» when only some lines were costed. A frozen row's «ویرایش» becomes «نمایش» and «پیشنهاد تازه از روی این» is the correction the freeze forces, pre-filled and with the contract and project pointers cleared. The brief picker holds only the chosen client's own briefs and the stakeholder picker only that client's contacts, in both directions — the shape of §A's rule, with 0276 as the rule. Live totals from the same pure module the service calls, so the figure being typed and the figure stored are one arithmetic |
| **Wave 7** — §A proposal tests | `agency-proposal.test.ts` (34, pure), `integration/agency-proposals.integration.test.ts` (27, real database) and 89 assertions against 0276 run directly over Postgres. The harness found three things nothing else could see: triggers firing alphabetically, a negative price reported as a bad `amount_rial`, and a code outside the revenue vocabulary reported as missing from the chart (decision 48). The integration suite found a fourth — the schema and the service disagreeing about whether an empty draft may be withdrawn, each self-consistent (decision 46) |
| **Wave 8** — §A multi-brand client | `src/lib/crm-org-structure.ts`: the pure reading of `crm_party_relationships`' two hierarchy kinds. Collapses `parent_organization` (parent → child) and `branch_of` (child → parent) to one `child → parent` statement, because they are the same fact stored twice and a resolver reading one direction looks correct in every test written against it. Total over any edge list: cycles terminate on a visited set, a brand with two claimed parents takes the newest and reports the other, and every walk is bounded by `ORG_DEPTH_LIMIT` with the truncation reported rather than silent. Contradictions come back in `conflicts` naming only their own members, never resolved quietly. No schema (decision 37), no industry gate (decisions 49–51) |
| **Wave 8** — §A organisation service and route | `organizationStructureFor` in `crm-relationship-service.ts`: two queries — one for the hierarchy edges with `business_id` on each `parties` join, one grouped read over the four registers that name a client, restricted to this group's own parties. Returns `null` for a party that is not this tenant's. `GET /api/crm/customers/[id]/organization` on `crm.view`, read-only: writes stay on `/relationships`, which already gates and audits them |
| **Wave 8** — §A organisation card | `customer-organization-card.tsx` on the 360° file, above «ارتباط‌ها». An indented, root-first list with each brand's work as a sentence rather than a grid of zeros, a link to the group's own file when this one is a brand, contradictions in words naming the parties to fix, and `paddingInlineStart` because the file is RTL. Renders nothing at all when the party is not part of a group |
| **Wave 8** — §A organisation tests | `crm-org-structure.test.ts` (19, pure) and `integration/agency-org-structure.integration.test.ts` (12, real database). The suite pins the direction collapse against edges recorded both ways, each brand's work counted against that brand and nobody else's, a second tenant unable to resolve a party or pull one in through a join, a cycle naming only its own members, the depth bound, a contact not becoming a brand — and the *absence* of a campaign count, so adding one is a decision somebody makes |
| **Wave 9** — §C campaign schema | `migrations/0278_agency_client_campaigns.sql`: one table, `agency_client_campaigns`. Downstream of the brief, the proposal, the contract and the project, so it carries five nullable reference FKs (`SET NULL`) and a trigger that validates each one belongs to this business *and* that a brief's or proposal's client equals the campaign's — §A's separation rule as a constraint. `party_id` NOT NULL, a `CA-` series with `UNIQUE (business_id, campaign_number)`, the window, `channels text[]`, `budget_rial` nullable and `spend_rial` NOT NULL DEFAULT 0 with **no CHECK between them** (decision 53), five attribution counts, `metrics_source` with exactly two values and `metrics_note` for the method (decision 54), RLS shape 1 with `ENABLE` + `FORCE`, `created_by` a bare uuid. The guard trigger allows DELETE only while planned and freezes a completed or cancelled campaign — with the cascade exemption and the audited-merge exemption, both narrower than they look (decision 56). Nothing in it posts |
| **Wave 9** — §C campaign vocabulary | `src/lib/agency-campaign.ts`: five statuses, five acts and the chain between them (`planned → running ⇄ paused`, either to `completed` or `cancelled`, both terminal), the freeze/editable/deletable predicates and `isAgencyCampaignInFlight` — running *and* paused, because a paused campaign's budget is still committed. `agencyCampaignMetrics` with every ratio null on a zero denominator, `agencyCampaignBudget` with `over` as a first-class state, `isAgencyCampaignCurrent` inclusive at both ends, and `NullableFieldResult` (decision 55). Dates reuse `src/lib/iso-date.ts`'s calendar-aware validator rather than adding a fifth implementation of one. Channel vocabulary *is* `agency-brief`'s, asserted identical rather than copied. Pure, so the panel may import it |
| **Wave 9** — §C campaign service | `src/lib/agency-campaign-service.ts`: eighteen refusal codes closed into `AGENCY_CAMPAIGN_ERROR_CODES` so the route's status map can be exhaustive over them; list, read, create, patch, action, delete. `countCampaignsByParty` answers a whole group's brands in one grouped read with `count(*) FILTER` for the in-flight subset — the piece wave 8's card was missing. The patch merges over the stored row, so `clicks` arriving alone is checked against stored impressions, and takes **no row lock**: the read exists to merge and to answer in words, but the authority on a closed record is 0278's trigger inside the write. Every statement carries its own `business_id`, inside every join |
| **Wave 9** — §C campaign HTTP | Three routes under `/api/crm/client-campaigns/**`, in the CRM door for the reason decision 39 gives, with one exhaustive error map in `src/app/api/crm/campaign-guard.ts` over eighteen codes plus 0278's deliberate SQLSTATEs. The lifecycle step is on its own `/status` route and rides `crm.manage`: completing a campaign closes a claim about attribution rather than approving money moving, and §D's `approve` is the determination that does. A new CRM section key `campaigns` with its access row, its aliases (and «کمپین» moved off the brief's list, where it had been pointing at the nearest thing), and its place in the «فرصت‌ها» group |
| **Wave 9** — §C campaign screen | `/crm/client-campaigns` and `campaigns-section.tsx`. Mostly arithmetic and dates rather than workflow, and §C's "no fake campaign performance" shows up as three refusals to pretend: no invented figure (every ratio «—» on a zero denominator), no platform to import from (two sources and no third), attribution stated beside the figure it explains. A closed campaign's controls are disabled rather than left to be refused, while its note fields stay open. The brief and proposal pickers hold only the chosen client's own records; the deal, project and contract pointers are shown but not settable, because project and contract live behind `workspace.view` and a CRM-only member must not get a directory of work they cannot see |
| **Wave 9** — the audited merge door | `migrations/0279_agency_party_attribution_moves.sql`: a **bug fix in shipped code**, found by giving 0278's campaign a merge disposition. 0274 and 0276 each froze `party_id` inside their substance comparison, so `mergeCustomers` failed with a raw `23514` on the CRM's duplicates screen whenever either client held a confirmed brief or a sent proposal. 0279 redefines both guards — never editing an applied migration in place — with the attribution split out and honouring 0217's transaction-local flag, and adds `crm_party_attribution_moves` so every move is audited before the door opens. Five registry entries now declare it (decision 56) |
| **Wave 9** — §C campaign tests | `agency-campaign.test.ts` (26, pure), `integration/agency-client-campaigns.integration.test.ts` (16, real database), `integration/agency-party-merge.integration.test.ts` (6, real database), `campaign-guard.test.ts` (6) and 66 assertions against 0278 run directly over Postgres. The integration suite covers what only a database can show: one number sequence under a race, an overspend recorded *and* reported as `over`, the four ratios and their nulls including `revenueRial: 0` giving no ROAS, list figures identical to detail figures, a one-field patch clearing nothing, the full lifecycle with its window requirements stated in words first, a closed campaign refused from both the service and a **raw** `UPDATE` that skips it, a foreign client refused by the trigger as `23514`, and two of one brand's campaigns concurrent in the same window. The merge suite pins both halves of decision 56 — the move lands with substance and lines byte-for-byte intact and an audit row written, and what was frozen stays frozen for every path that is not the audited merge |


## Decisions

### 1 — the family is `service`, and Workspace eligibility is a separate axis

`industryFamily` answers `service`, not `project_based`: the family is the axis the *shared ingest
engines* branch on, and what they need to know is that this trade has no sellable catalogue. The
issue's "project-based Workspace eligibility" is a different question — whether My Workspace is
offered — and it belongs to #1110's eligibility matrix, which is not on `main` yet. Both notes are
in the registry entry so the #1110 wave names this trade instead of rediscovering it.

### 2 — one industry, eight operating profiles

Full-service, digital/social, branding and creative, media buying and performance, outdoor and
print production, content and video, PR and events, and the one-person studio are **presets** over
templates, default navigation and KPIs inside the one key — the reasoning migration 0193 recorded
for AEC's eight profiles. A preset never replaces role authorization: what a member may do stays
`permissions.ts` and the project role.

Wave 1 shipped no preset machinery, because a preset with nothing to switch on is a dropdown that
lies. Wave 2 gives it something real to switch on — the seven blueprints — and stops there. What a
preset does today is decide which of them are badged «پیشنهادی» and listed first; what it does not
do is steer navigation or KPIs, because neither has an industry-aware surface to steer yet (see
«What this change does not build»). `agency.ts` therefore holds a label, a description and nothing
else per preset, and `agency.test.ts` fails if a definition grows a fourth field or the module
imports permission code: the smallest machine that is honest about what it does, and one that cannot
quietly become an authorization layer.

### 3 — the chart is built by subtracting from F&B

Like `SERVICE_SAAS_COA_TEMPLATE` and `ARCHITECTURE_CONSTRUCTION_COA_TEMPLATE`: every shared Iranian
accounting control (cheques, payroll and its withholdings, VAT, advances, fixed assets, marketing,
multicurrency) stays present *by construction*, and the café's own lines are removed by an explicit
list that `coa-template.test.ts` asserts. Removed for this trade: the hospitality revenue lines
(food, beverage and the three sales channels) and the service charge, the delivery-marketplace
**pair** (1230 and 5650 — an agency is not on a food-delivery platform, and what it may hold
against a *media* platform is a client pass-through with its own account), and the kitchen's
inventory machinery (5100, 5150, 5160, 5180, 1310).

### 4 — four revenues, and no revenue per billing mode

| Code | Account | What it is for |
|---|---|---|
| 4640 | درآمد خدمات تبلیغاتی و مدیریت کمپین | the default a service invoice credits |
| 4650 | درآمد طراحی، برندینگ و تولید محتوا | creative, brand and content fees |
| 4660 | درآمد رسانه (خرید فضا و زمان و کارمزد مدیریت) | media, gross or net — see 5 |
| 4670 | درآمد روابط عمومی، رویداد و اجرا | PR, events, experiential |

Retainer, fixed-price, milestone and hourly/time-and-material are deliberately **not** revenue
accounts: they are billing *modes* over these same four kinds of work, and Accounting's documents
already carry them. A revenue account per mode would double-count the service line it bills.

### 5 — gross vs. net is the business's policy, and the chart infers neither

§D's requirement, made mechanical rather than guessed. An agency billing media **gross** credits
4660 with the whole recharge and debits 5197 with the buy; an agency billing **net** credits 4660
with only its management fee and never routes the client's media money through revenue at all — it
arrives as 2430 (customer advance), leaves as 2140 (media payable), and sits in 1270 in between if
the agency paid it first. Nothing in the code decides which of the two a business does, and nothing
infers it from the size of the spend.

### 6 — direct client cost is cost of sales; the agency's own marketing is not

`costOfSalesCodesForIndustry("advertising_agency")` = 5196 (project/campaign direct cost), 5197
(media buy), 5198 (production, print and making), 5199 (subcontractors and freelancers), plus 5105
so the periodic system's gross profit stays honest mid-period. That is what makes gross profit read
as *client margin*. 5600 (بازاریابی و تبلیغات) stays out of the list on every chart: money spent to
win the agency's own next client is overhead, and folding it into a client's job margin is exactly
the confusion §C's "distinguish the agency's own marketing from client campaigns" is about.

### 7 — reuse, never a second concept

* **2430 «پیش‌دریافت از مشتری»** is the client retainer, the milestone deposit *and* the media fund
  a client hands over to be spent. There is no agency-specific advance liability — the same rule
  #839's §7 applied to vehicle reservations, asserted by a test that counts the chart's
  «پیش‌دریافت» liabilities and requires exactly one.
* **1300 «موجودی مواد و کالا»** is the trade's only stock account, for the print/production material
  an outdoor or print agency genuinely holds (vinyl, paper, ink, merch). It is the *generic* account
  because the profile grants no `stock` and no `inventory` module: the account is reached through
  Accounting's own documents and never through a warehouse screen, and a trade-specific inventory
  account would advertise a stock manager this trade deliberately does not have. Print-production
  stock stays opt-in until a real supported workflow exists, as the issue requires.
* **1270** (reimbursable client cost) and **1385** (unbilled project work) are new because nothing
  on the shared chart means either: 1200 is an invoiced receivable and 1300 is material.

### 8 — a service-invoice trade: `pos` is the address of the invoice screen, not a counter

This decision changed between wave 1 and wave 2, because `main` moved under it. Wave 1 gave the
agency no `pos` at all, exactly as AEC had none before #799's service invoice landed — and that left
the trade with no way to bill a client, which is §D's whole subject. `main`'s `2707a540` ("Add a
service invoice for contracting and service trades") answers the same problem for the two existing
service trades by making `pos` mean *the screen an invoice is written on* (`/accounting/pos` in
invoice mode, `/api/sales`) and adding one line kind to the retail invoice — `kind: "service"`, a
described service at a quantity, a unit price and a VAT rate, crediting a revenue account chosen
from the trade's own list, with no stock decrement and no COGS.

So the agency joins that pattern instead of inventing its own: `modules` is
`[...CORE_MODULES, "pos"]`, `SERVICE_INVOICE_INDUSTRIES` names it third, and
`SERVICE_REVENUE_ACCOUNTS.advertising_agency` is the chart's four service revenues in chart order —
which makes 4640 (campaign management) the default, the same account
`accounting-posting-rules.ts` names for the trade. That is §D's split as a ledger fact: a retainer
line credits 4640, a media recharge 4660, a video production 4650, so a campaign P&L can read the
agency's own fee apart from money it only passes to a publisher instead of inferring the split from
how large a line is.

What `pos` must never bring with it is the counter around that address: no `orders`, no `stock`, no
`menu`, no `inventory`, no trade catalogue, no catalogue pointer on the wizard's finish page, and a
line-kind list of exactly `["service"]`, so a stocked line is refused for this trade.
`industry-profile.test.ts` pins both halves — the forbidden module list, and the one `pos` nav entry
the rail gains, labelled with the agency's own noun. `tenant-navigation.test.ts` and
`accounting/service-invoice-nav.test.ts` pin the sidebar half.

### 9 — classification: one new block, and two deliberate non-roles

214x joins the `trade_payable` block in `account-classification.ts`, so what an agency owes media
owners, printers, production houses and freelancers appears in the payables dashboard and the A/P
aging like any other supplier debt. 1270 and 1385 are deliberately **unclassified**: an unbilled
pass-through is not an invoice the client owes yet, and classifying it would put client media money
into the A/R totals and offer the account as a way to settle a fixed-asset sale
(`ASSET_SALE_PROCEEDS_ROLES`). Both are asserted in `account-classification.test.ts`.

### 10 — the switch warning is a family rule, not an agency rule

`industrySwitchCautions` gains one caution for *any* catalogue → non-catalogue switch, because the
meaning change is the same whichever service or project trade the operator picks: the stock rows
survive, the ability to sell them does not, and a storefront order stops being a sale. Stating it
per industry would have left AEC and `service_saas` silently unwarned about the identical switch.

### 11 — the preset is a setting, not a table, and not a wizard step

AEC's profile lives in `aec_business_profiles` (migration 0194) because it stores nineteen
capability overrides and a specialty list per business, and because #799 made choosing it a step of
onboarding. An agency's preset is one word. It therefore goes into the key/value `settings` table
the platform already gives every business-wide preference — `SETTING_KEYS.agencyProfile` — with no
migration, no new table and nothing an existing tenant can lose. That is also why the reader is
defensive rather than coercive: an unrecognised value answers "nothing stored" instead of quietly
becoming `full_service`, so a value written by a newer version or by hand is never overwritten by a
later save.

The issue allows the choice to live in the wizard *or* in tenant settings, and settings is the half
this change takes. The agency's `SETUP_SHAPE` is `service`, whose seven steps are the contract
`setup-readiness.ts` and `src/app/setup/steps.test.ts` assert for every service trade; an eighth
step for one industry would either fork that shape or make a freelancer answer a question they
should be able to skip. AEC's step exists because nineteen capabilities have to be settled before
its screens make sense — seven blueprint orderings do not.

### 12 — seven blueprints, as code, with both control points in every one

§B's stage list runs brief → discovery → proposal → contract → kickoff → concept → production →
internal review → client approval → publication → reporting → handover. The seven templates re-cut
that spine per engagement (a retainer has no contract phase every month; a shoot has a production
day the others lack) but every one keeps the two phases an agency is judged on: an **internal
review** before the client sees the work and an explicit **client approval** before publication.
`agency.test.ts` asserts both in all seven, so a blueprint added later cannot drop the agency's
control points by accident.

They are code rather than seeded rows for the three reasons `workspace-aec-templates.ts` records —
a new tenant has all seven on its first request, a fix reaches every business at once, and there is
no per-tenant copy to drift — and applying one remains a *starting point*: it writes phases and
starter tasks the project then owns, and nothing re-reads the catalogue afterwards.

### 13 — a preset orders and labels; it never gates

`recommendedProfiles` was typed to AEC's vocabulary, so widening it to a union is the whole of the
change: `templatesForIndustry` still filters by `industry` first, and the profile only decides which
of the eligible blueprints carry the «پیشنهادی» badge and come first. A media buyer who lands a
shoot still gets «تولید محتوا و ویدیو»; a branding studio still gets «کمپین تبلیغاتی جستجو و
اجتماعی». Two tests hold the line — one that a preset from the *other* industry badges nothing
(the vocabularies are disjoint, so a crossed wire cannot guess), and one that every preset is
recommended by at least one blueprint (a preset that reordered nothing would be a form with no
effect).

### 14 — two registers, not three: there is no billing-plan table

§D names four ways an agency charges (fixed price, milestone, retainer, hourly) and it is tempting
to give each a row somewhere. They are one vocabulary instead — `AGENCY_BILLING_BASES` in the pure
module — and what a base produces is a set of milestone drafts (`draftScheduleForBase`) plus a
`kind` on each row: `deposit`, `deliverable`, `retainer_period`, `final`. A plan table would have
been a third place holding a fact the schedule already holds, and the two would have had to be kept
equal by hand. Hourly is the case that proves the choice: it lays out **no** schedule, because there
is nothing to lay out before the time is tracked, and a table of plans would have wanted a row for
it anyway.

### 15 — deposits stay out of the money path

A `deposit` is a milestone kind that gets invoiced like any other stage. It is deliberately **not**
a customer advance drawn down against later invoices: 2430 in this product is a retail layaway
deposit (`coa-template.ts`), and reusing it would make an agency's retainer a liability somebody has
to remember to relieve. Drawing down an advance needs its own document and its own settlement rule,
which is a later wave's work rather than a flag on this one.

### 16 — a percentage is resolved at invoice time and never written down at rest

The row keeps `percent`. What it means is computed against the engagement's *revised* value at the
moment the invoice is issued, and from then on the row reports the invoice's own figure
(`billedAmountRial`) rather than today's reading of the percentage (`billableAmountRial`, which goes
null). Storing the resolved amount would freeze a percentage against a value that later change
requests move, and would leave the register holding two figures that have to agree with each other —
the same defect decision 17 avoids on the contract.

### 17 — an approved change request moves a revised value, never the signed one

`workspace_contracts.value_rial` is what the client signed, and nothing in this wave rewrites it.
The revision is *read* — contracted plus the sum of approved and implemented change requests — so
both facts stay separately readable and the difference between them is the commercial story of the
project. The screen shows both, and the approve dialog asks for the agreed figure separately from
the one that was asked for, because agreeing a smaller number is not a correction of the request.

### 18 — the author's acts are `workspace.manage`; the determinations are `workspace.approve`

§24's rule that a high-risk commercial action must not inherit ordinary edit rights, applied to two
chains. The first draft of it gated `submit` on `workspace.approve`, which would have made it
impossible for the project manager who owns a schedule to send it — and would not have made anything
safer, because the approvals engine refuses a self-approval on the other side. So sending, taking
back, re-opening, pricing, re-pricing and implementing are edits, and agreeing, refusing, cancelling
and invoicing are determinations.

That is only sound if the refusal actually runs. These registers write their own queue row directly,
so the register move and the queue row commit together, and they own their own decision path —
which meant they did **not** inherit `approvalDecisionError`. Both decide paths now run it
explicitly. Without that, one manager holding both permissions could send a milestone and approve it
themselves, and the split above would have been decoration.

### 19 — approving a milestone does not bill it

`invoice` is a separate act with a third gate: `workspace.approve` plus the pair the invoice screen
itself is on (`paymentsTake` then `ordersCreate`, i.e. `canUsePos`). Without the second half, a
project manager who may not take payments could take them through the workspace door instead — the
one capability no screen would have offered them. Approval says the milestone *may* be billed, and
says nothing about who may bill it.

### 20 — the posted half of the P&L is read, never stored

Revenue and actual cost come from one query over `journal_entries.project_id` joined to
`journal_lines` and `accounts`, selected by account *type* rather than by a list of codes. Nothing
here stores a balance that could drift from the ledger. That read only works because the invoice's
project dimension now travels through the posting rule (decision 8's `service.sale_revenue`, plus
`projectId`), and it is why that change is four lines in three files rather than a reconciliation
job. A project the ledger holds nothing on yet reports **null** for the whole posted half and no
margin at all, because "nothing has posted" and "this campaign earned nothing" are different claims.

### 21 — what wave 3 deliberately did not build

Two things §D names that are not here, each for a reason worth recording rather than a shortage of
time:

* **The vendor chain** — quote → approved purchase/expense → payable → settlement. It must ride the
  existing posting and domain-event engine, which it does in procurement's registers; putting a
  second copy of that shape inside a billing register would give the same payable two homes. The
  accounts it posts to (2140, 5196–5199) are seeded and the project dimension it needs now exists.
* **Gross vs. net pass-through.** A media recharge is still booked gross as revenue, and 1270
  (reimbursable client cost) is still unreached by any document. Which way a given agency books it
  is an accounting policy that needs its own decision, its own document and its own posting rule —
  not a flag on an invoice, and above all not something inferred from how large a line is, which is
  precisely what §D forbids.

### 22 — a `date` column is a `Date`, and the type says otherwise

CI's integration shard was the first place this service ran against a real database, and it found a
fault no unit test could: node-postgres hands back a Postgres `date` as a JS `Date`, so every
`start_date: string | null` in a query's row type was a lie the compiler accepted. The engagement's
`start_date` went straight into `addMonthsIso`, which threw `iso.trim is not a function` — an agency
whose contract carries a start date could not lay out a billing schedule at all.

`readDate` / `readInstant` now convert on the way out, and `readDate` goes through `postgresDateToIso`
rather than slicing an ISO timestamp, because slicing reads UTC: Tehran midnight is 20:30 the previous
day there, so every due date would have shifted back a day. The rule for the next wave is that **a
row type describing a `date` column is `Date | string | null`, never `string | null`** — the same
fault `workspace.ts` already documents for its own reads.

### 23 — both registers PATCH, and one pair of fields does not merge

Both update functions re-validated the request body on its own instead of merging it into the row, so
every partial edit failed: changing a milestone's percentage demanded its title again and wiped the
amount, the dates and the hours it never mentioned. A field the caller does not name now keeps the
value the row holds.

The percent/amount pair is the one deliberate exception. The two are mutually exclusive, so naming
either *replaces* the pair rather than merging into it — `{percent: 40}` at a milestone priced in
Rials means "price it as forty percent now", not "forty percent and the 12 000 000 rials already
stored". Hours describe what an amount covers, so they fall away with it unless the caller names them
too. A priced change request stays editable for the same reason: otherwise one priced before its
schedule impact was known could never be sent, never be corrected, and could only be withdrawn.

### 24 — the round is the version: §E adds no version table and reuses no `ai_status`

§E asks for "versions". The tempting read is a `media_asset_versions` table, and the library already
has a column that looks like a review state: `media_assets.ai_status`. Both were refused.

`ai_status` records an operator confirming a label the AI proposed. It is about metadata provenance,
not about a client's verdict on an artwork, and overloading it would make the two questions
unanswerable separately — a file whose AI caption was confirmed would look client-approved.

Versions are rounds instead. A round is a set of assets put to the client at one moment; `approved` is
terminal precisely because the next revision is a *new* round that supersedes it, and the chain of
rounds over a project is the version history. `version_label` names one («نسخهٔ ۲», «چاپ نهایی»)
without inventing storage for it. This is also why no round may return to `draft`: a round a client has
seen is a fact about the project, and unseeing it would erase the trail.

### 25 — shared tables get trigger-validated refs; §E's own get composite foreign keys

Every reference a round makes has to be tenant-checked, and the two kinds of table available do not
offer the same tool. §E's own tables carry `(business_id, id)` uniqueness, so their internal refs are
plain composite foreign keys — the database refuses a cross-tenant child row outright, which is why the
guard suite can prove that with a raw insert.

The four shared tables a round points at (`media_assets`, `ai_projects`, `parties`,
`growth_campaigns`) have no `UNIQUE(business_id, id)`, and adding one to `media_assets` would touch a
table §E has no business changing. Those refs are validated by triggers asserting the owner matches,
which gives the same guarantee in a place that can be reasoned about per-table. The guard suite names
each one, so a future migration that drops a trigger fails a test instead of silently opening a
cross-tenant reference.

### 26 — bytes stream through the app; the presigned URL is left unused

`presignS3Get` exists and would have been one line. It was refused because a presigned URL cannot be
revoked once issued and leaves no trail: the object store answers the client directly, so the app never
learns that a fetch happened, and §B's "revocable scoped" links stop being revocable for as long as the
URL lives.

Bytes therefore stream through `/api/media/review/[token]/assets/[assetId]/file`, which resolves the
token, checks the asset's membership in *that* round, and only then reads storage. Revocation bites on
the next request, the use counters move, and a whole-file fetch writes an event. `storage_key` never
leaves the service, and the streaming call still goes through `streamMediaObject`'s
`keyBelongsToBusiness`, so the defence does not rest on §E's own query being right.

Authorisation is a separate function from streaming for one reason: answering a conditional request
(304, 416) must not cost a storage read, and bundling the two would have made every `If-None-Match` a
full authorise-plus-fetch.

### 27 — the token is a hash at rest, and its shape is checked before any lookup

The token follows `api-auth.ts` exactly: `bmrl_` plus 32 random bytes base64url, with only its sha-256
hex digest stored. The plaintext is returned once, to the member who minted it, and cannot be recovered
afterwards — so reading the database does not hand over working links, and the 64-hex CHECK in 0265
means a malformed digest cannot be stored at all.

Shape is validated before any lookup, and the shape functions live in the pure module so the service
and the client screen agree on what a token looks like. A random string in a URL therefore costs one
comparison, not a query. A 16-character display prefix is stored alongside, so an agency can tell two
links apart in a list without ever seeing either secret.

### 28 — purpose governs intent and disposition, not whether bytes may be served

This one was wrong first, and the client screen is what proved it. `createReviewLink` mints a link as
`review` unless an agency asks for `download`, and the first cut of `authorizeReviewAsset` refused
*every* byte fetch for a `review` link. That made the default link render broken images: a client who
cannot see the artwork cannot approve it, so the gate contradicted the feature it guarded.

Purpose now gates an explicit ask to take the file (`?download=1`), which only a `download` link may
make; the default render is inline either way. Two honest notes sit in the code, because the
distinction is narrower than it sounds. Bytes served for viewing can always be saved by a browser, so
no response header prevents a determined client from keeping the file — what purpose buys is a truthful
audit trail (`asset.viewed` vs `asset.downloaded`), and keeping print-ready originals away from an
unpaid client is a watermarking problem that is out of scope here. And the purpose must not force
`attachment` on its own: that disposition on an `<img src>` makes the browser save instead of render,
which would break the preview for exactly the `download` links that ought to show the most.

A link's authority never moves, live or revoked. Only `revoked_at` (once) and the use counters change,
so a revoked link still records that someone tried it — which is the evidence an agency wants.

### 29 — the client is an actor, never a member

The person at the far end of a review link has no `users` row and must never get one: §B asks for
external review "without a new staff identity system", and a user row would be exactly that. They are
recorded as an *actor* — `actor_kind` of `member | client | system`, with `actor_label` NOT NULL so the
trail names who decided even when there is no account to join to. The client's own name is captured on
the round when they decide, defaulting to «کارفرما» rather than left blank.

This is also why there is no approve-style media permission, and why the page is public in exactly the
way `/invite` is. Authorisation here *is* the token: `withTenantScope` reads `cookies()`, so the client
routes cannot use it and are plain handlers. The middleware entry is prefix-matched, which is what makes
the spelling safe — `/api/media/review` publishes the three token routes and does not publish the
agency's own `/api/media/review-rounds/…`, because that path does not start with `/api/media/review/`.
The `PUBLIC_ROUTES` entries in `api-guards.test.ts` landed in the same commit as the routes, since that
test asserts every exemption key has a real file behind it.

Events are append-only with no draft exception. A draft deletion is recorded in the surviving
`audit_log` instead, so nothing a member did disappears without a trace even when the row does.

### 30 — two doors and two freezes, mirrored from the database guard

`reviewRoundActionsFrom` deliberately returns *both* sides' acts, which made it unusable as
`ReviewRound.actions`: a screen reading that field would offer a member an **approve** button the API
then refuses. There are now two doors over one act table — `actions` for the agency
(`agencyReviewActionsFrom`) and `clientActions` for the client — and `ClientReviewView.actions` is the
client's door, assigned from `round.clientActions`.

Freezes are two, and they are not the same set. `media_review_round_guard` freezes title and scope for
`sent | withdrawn`, the whole row for `approved | rejected`, and nothing for `changes_requested`; items
are governed by a different predicate again. Collapsing them would make the `changes_requested` case
unsayable — frozen in title and scope, yet happily taking assets again — so item mutations raise
`round_not_open_for_items` while identity mutations raise `round_frozen`. Both mirror the trigger so a
screen gets a translatable code instead of a raw 23514: mirroring only in the database gives the UI
nothing to say, and mirroring too strictly blocks a legitimate typo fix on sent-back work.

`sent_at` is set once by `coalesce` and never cleared nor overwritten on re-send, because when the
client first saw the round is a fact, not a property of the current send.

### 31 — tenant scoping is a predicate, not an ambient assumption

`withTenant(businessId, …)` establishes the RLS scope and nothing else; it never injects `business_id`
into the SQL. The first cut of this service had zero `business_id` predicates and fourteen id-alone
lookups, and it passed every unit test — because the integration harness connects as `pos`, a
superuser, and a superuser bypasses RLS even under FORCE. Against a real tenant the only thing standing
between one agency's rounds and another's was a policy the connection was exempt from.

The service now carries 32 explicit `business_id` predicates, which is the house style: `workspace.ts`
has 80, `media-service.ts` 30, `agency-commercial-service.ts` 22 with no id-alone lookups at all, and
no service uses `app_current_business()` in application SQL. RLS is the backstop, not the plan. The one
intentionally unscoped query is the token hash lookup, which must find the business before it can scope
to it, and it runs under `withoutTenantScope("media-review-token")` so the exemption is named.

### 32 — §E is not industry-gated, and it posts nothing

§D asserts `advertising_agency` before it will act. §E deliberately does not: the Media Library is a
platform feature, and the agency-specific part is only the nullable format vocabulary (`copy`, `logo`,
`print_ready`, …) that labels an item. Gating review rounds by industry would deny every other trade a
client-approval flow for no reason, and the whole flow is proven on a `jewelry` tenant in the
integration suite.

Nothing here posts a journal entry or moves money. §E is a review and handover surface, so it stays out
of the accounting path entirely — the media recharge in §D's P&L is a different concern.
### 33 — §A adds no CRM engine, because the CRM is already there

§A reads like a request to build something: "agency client companies with multiple contacts/brands, inbound lead intake, opportunity pipeline, client briefs, qualification, proposals/quotes, scope of work and contract renewals". Recon found twenty-one `crm_*` tables already in place — `crm_pipelines`, `crm_pipeline_stages`, `crm_deals`, `crm_deal_stage_history`, `crm_leads`, `crm_activities`, `crm_party_relationships`, `crm_consent_events`, `crm_custom_fields`, `crm_scoring_state`, `crm_merges`, `crm_audit_events` — and roughly fifty service modules covering dedup, merge, ownership, scoring, consent, automation and saved views.

So the second clause of §A is the operative one: leads and opportunities "must reuse canonical CRM records and existing dedup, activity history, consent, ownership and tenant permissions". Most of that is not work, it is a constraint that rules work out. What §A actually owes is the agency's *shape* on top of machinery that already exists, which is why the pipeline slice adds no table, no entity and no engine — only a list of stage names the platform's own `crm_pipeline_stages` already holds.

### 34 — the agency gets a second pipeline, not a different default

The obvious implementation is to fork `SEED_STAGES` by industry, and the file argues against it in terms: its six are the six the pre-0157 `CHECK` allowed, "so a freshly provisioned business and an upgraded one have structurally identical pipelines. Anything else would mean two code paths to test and a subtle difference nobody notices until a report disagrees between two tenants."

That argument holds, and it is about reports rather than about tidiness. A win rate or a forecast over the default pipeline has to mean the same thing for a café and an agency or the number is not comparable, and the divergence would be invisible until somebody reconciled two tenants side by side. So the agency's track sits *beside* the universal default — which `createPipeline`'s own docblock already anticipates, naming "a tender track, an after-sales track" as the reason a second board exists. The default is untouched, no existing tenant's reports move, and a member who wants the agency track as their default promotes it through `updatePipeline`, which clears the previous one so exactly one remains.

This is also why the preset's stages carry no `legacy_key`. `SaveStageInput` has no such field and `legacyStageKey` exists to recognise the pre-0157 strings; reusing `lead`/`proposal`/`won` would have made reports keyed on the legacy vocabulary count agency stages as though they were the seeded ones, which is the same silent disagreement from the other direction.

### 35 — direct inserts, because composing the two existing functions leaves wreckage

`createPipeline` copies the source pipeline's stages, and `savePipelineStages` *deactivates* rather than deletes the stages missing from the list it is given — rightly, because a deleted stage would leave its deals on no board at all, invisible to every forecast and discoverable only by querying SQL. Composing the two therefore leaves six deactivated copies of the default's stages beside the seven agency ones: rows that mean nothing, listed by a configurator that shows inactive stages, created by a function whose whole job was to make a tidy starting point.

Nothing catches that. It type-checks, it passes every unit test, and the seven right stages are present and active — the six wrong ones are merely also there. Only a real database shows it, so one of the eight integration tests counts inactive stages across the entire tenant and requires zero. The preset inserts directly instead, and still cannot be rejected by the rules `savePipelineStages` enforces, because the pure module's own tests assert both invariants: at least one `open` stage, so a deal can be created, and at least one `won` stage, so the win rate is not structurally zero.

### 36 — the read path creates it, but only the reads that look at pipelines

`defaultPipeline` self-heals for a reason worth copying: migration 0157 seeded every business that existed when it ran, and businesses created afterwards get a pipeline only if every provisioning path remembers to — there are three of them (`business-provisioning`, `pairing-apply`, `platform-service`) and nothing stops a fourth. A read that creates what it needs cannot be forgotten by a new provisioning path.

The tempting version is to put the agency step inside `defaultPipeline` and inherit all six of its call sites for free. Refused, because two of those sites are deal creation and lead conversion — write paths where a second pipeline's creation has no business running — and because `defaultPipeline`'s contract is to return *the default*, which the agency's track is not. It is called from the two routes where a member actually looks at pipelines instead: the configurator under `crm.configure` and the board under `crm.view`. The second matters: a sales-only member who never opens CRM settings still gets the track the first time they open the board, and a preset that only appeared after a visit to settings would look broken to exactly the people it is for.

### 37 — §A's multi-brand client needs no schema at all

"Agency client companies with multiple contacts/brands" and "stakeholder/approver contact is recorded without exposing another client's information" read like new tables. `crm_party_relationships` already carries `kind` over `contact_of`, `decision_maker`, `billing_contact`, `purchasing_contact`, `owner_of`, `household`, `referred_by`, `parent_organization` and `branch_of`, plus `role_title` and `is_primary` — which is a client company, its brands, its contacts and its approver, expressed in vocabulary that already exists and already has tenant scoping, an audit trail and merge behaviour.

Recording that here is the point: the next reader of §A will otherwise spend the effort discovering it again, or worse, build the table.

### 38 — one brief table across both of its moments

A brief is written against an opportunity while the deal is still open — §A's pipeline stage «بریف کارفرما» is exactly that moment — and it is then what the project delivers against, which is why §B lists `brief` among the project's own metadata. The temptation is two tables, one in the CRM and one in My Workspace, each scoped to the thing it belongs to. Refused: they would be the same brief in two places, free to disagree about what the client asked for, and the disagreement would be invisible until somebody priced a proposal against one and delivered against the other.

So it is one table with two nullable pointers. `party_id` is NOT NULL, because a brief with no client is the agency guessing and guessing is the thing a brief exists to stop. `deal_id` and `project_id` are both optional and both `ON DELETE SET NULL` rather than `CASCADE`: a brief is the record of a requirement, and a lost deal or a cancelled project does not unask it.

It is also not `crm_custom_fields`, which could hold every one of these values per tenant and still may. What a brief has and a custom-field value does not is a *life cycle* — drafted, sent to the client, confirmed by a named person, later superseded — and custom-field values have no status, no stamps and no freeze. What makes a brief worth anything is that it is the version the client confirmed, which is a fact about time rather than a value in a column.

### 39 — the CRM door, not the agency door

§D's registers live behind `/api/agency/*`, whose guard resolves its owner through `workspaceOwner` and so applies the workspace *projects* service gate and project membership. That is right for a billing schedule, which lives inside a project and is meaningless without one. It would be wrong for a brief, which is written during sales and usually before any project exists: gating it on the projects service would make it unusable in exactly the moment §A's pipeline stage describes, and invisible to a sales-only member who holds the CRM and not My Workspace.

That is decision 36's lesson arriving from the other direction. There, the question was which *read* should create the agency pipeline, and the answer was the board rather than only the settings screen, because a preset that appeared only after a visit to settings would look broken to exactly the people it is for. Here the question is which door the feature hangs off, and the same people give the same answer: `crm.view` to read, `crm.manage` to write, `crm.delete` to delete, in `/api/crm/briefs`, as a CRM section beside the deals a brief hangs off.

It is not industry-gated either, which repeats decision 32 for the same reason: the permission is the gate, and a tenant whose members hold it may use the feature. Nothing about a brief requires an advertising agency, and a preset orders and labels rather than gates.

### 40 — §A's stakeholder rule is a constraint, and the picker is its shape

"Stakeholder/approver contact is recorded without exposing another client's information" reads as a design instruction about the UI. It is enforceable more strongly than that, and decision 37's finding is what makes it so: `crm_party_relationships` already expresses who is a contact of whom, in vocabulary that already has tenant scoping, an audit trail and merge behaviour.

So migration 0274's trigger requires an edge between the approver and *this brief's own client*, in either direction, and refuses the write without one. The consequence is concrete rather than decorative: one client's decision-maker cannot be recorded on another client's brief, so no screen that renders the approver can put one client's contact inside another client's file. Without the constraint the rule would hold only for as long as every picker remembered it.

The screen then expresses the same rule as a shape rather than a warning — the approver options *are* the chosen client's contacts, so another client's decision-maker is not on offer — and picking a different client clears the approver, because the previous client's contact is not this client's. The picker is a convenience; the trigger is the rule. Both are tested, and the integration test asserts that a refusal wrote nothing at all, because a passing negative test is worth nothing if it was refused by some other constraint.

### 41 — what freezes at confirmation, and what deliberately does not

Once the client has confirmed, the substance stops being editable: title, objective, audience, channels, deliverables, budget, dates, acceptance criteria, the approver and the client. The reason is not tidiness — a proposal priced the brief, a project may be delivering against it, and a change request departs from it, so an edit in place would make all three cite a document that no longer says what they read. A correction is a new brief that supersedes this one, which is also what leaves a trail where an edit would leave none.

Three things are deliberately *not* frozen, and each is a decision rather than an oversight:

* **our own note**, which is the agency's and not part of what the client agreed — §E's review round makes the same split;
* **`deal_id` and `project_id`**, which say where the work lives rather than what was agreed. The project normally arrives *after* confirmation, so freezing the pointer would break the §A→§B handoff, the one transition this table exists to serve. That is precisely the reasoning which leaves 0260's `invoice_order_id` writable after its milestone is approved: it is the one write that happens after the determination. An earlier version of 0274 froze `project_id`, and the 48-assertion harness caught it — the type-checker and the unit suite both passed with the handoff broken;
* **the status chain and its own stamps**, because confirming and then superseding is the point. `sent_at` and `confirmed_at` are set once and can never be cleared: re-sending a correction is a new brief, so each stamp is a fact about the first time the client saw it.

The mirror case matters as much. A client being deleted takes its briefs with it, confirmed or not: with no counterparty left there is nobody for the record to speak for, and refusing would let one confirmed brief block the deletion of the very client it belongs to. Absence of the party is what tells the guard that a delete is the cascade rather than a direct one — the test 0265's item guard applies to its round. A blanket "only a draft may be deleted" without it is the trap: it looks like a stronger rule and quietly breaks a parent's `ON DELETE CASCADE`.

### 42 — one permission for the whole chain, and two acts MCP must never get

§D's change requests split `workspace.manage` from `workspace.approve`, because agreeing *somebody else's figure* is a different power from drafting one, and money moves when it is agreed. A brief's `confirm` looks like the same shape and is not: it records the **client's** decision, and the agency member is only the scribe. Nothing is priced, nothing posts, and no internal determination is made. So the whole chain sits on `crm.manage`, and the split would have invented a tier with no power behind it.

What does follow from that is a constraint on automation. `confirm` attests that a human at the client agreed to something, and `supersede` retires a brief they confirmed — so neither may ever become an MCP verb, because §F's rule that an assistant drafts and a human approves exists to prevent precisely that attestation being machine-made. Drafting and reading a brief are different in kind and are what a future tool should expose. The coverage row records this, so the gap reads as a decision rather than as an omission waiting to be filled.


### 43 — §A's proposal and §D's estimate are one document

§A asks for "proposals/quotes" in the CRM and §D asks for "service/project estimates" in the billing set. They are the same thing, and §B's stage list is what settles it rather than anybody's opinion: "brief → discovery → **proposal/quote** → contract → kickoff". One name, one position, one lifecycle. Two tables would be the same offer in two places, free to disagree about the price — and a price two systems disagree about is the one disagreement a client always notices.

So it is built once, as `agency_proposals` and `agency_proposal_lines` (0276), and it sits where §B puts it: a brief (0274) records what the client asked for, a proposal records what the agency offers in answer and at what price, and `workspace_contracts` (0167) records what was signed. That is why a proposal carries three pointers written at three different moments — `brief_id` at the start, `deal_id` and `project_id` as the work takes shape, and `contract_id` only after acceptance. `workspace_contracts` was read before this was decided, and its `contract_type` vocabulary is mostly inbound (contractor, supplier, vendor, subcontractor); it is the signed agreement, and a proposal is the offer that precedes it.

`brief_id` is a *simple* foreign key, not the composite one 0274 made possible, because Postgres refuses `ON DELETE SET NULL` on a composite key whose other column is `NOT NULL` and `business_id` here is. Tenant ownership of the brief is therefore the trigger's job, alongside the sharper question the foreign key cannot ask: whether the brief was written for *this* client. Pricing client A's brief for client B would put one client's stated requirement inside another client's offer, which is §A's leak arriving from the other direction.

### 44 — the header stores no total, and a line's amount is computed rather than trusted

`discount_rial` and `tax_rial` are on the header because they are policy inputs somebody chose. The subtotal is the sum of the lines and the total is derived from both, on every read, in one pure function. A stored total is a second answer to "how much", and the only way to keep two answers agreeing is a trigger whose whole job is bookkeeping — so there is one answer, which cannot disagree with itself. The integration suite asserts that a list row's figures equal the opened row's, because a summary that disagreed with its own detail view would be the more dangerous kind of wrong: it would look like agreement.

Each line's own `amount_rial` *is* stored, and is computed by a trigger from quantity × unit price rather than accepted from the caller. A line whose amount disagrees with its own quantity and price is a bug nobody can see, because both readings look correct on a printed quote. Storing it at all is still right: a list, a print template and an eventual invoice all need it, and none of them should re-derive it slightly differently.

The TypeScript side computes the same figure, in `agencyProposalLineAmountRial`, so the number under the member's cursor and the number in the row are one arithmetic. That is the one place a rounding rule could silently differ — Postgres rounds `numeric` half away from zero, `Math.round` rounds half up, which for the non-negative figures allowed here are the same rule — and the integration suite pins both sides on a `.5` case. A one-rial gap is invisible in review and maddening in an audit.

Quantity is `numeric(14,3)` rather than an integer because agency work is sold in halves and thirds: ۱٫۵ روز مدیریت هنری, half a retainer month. An integer column would have forced every such line to be rounded up and quietly overcharged for it. The form's own digit-stripper has to keep the decimal separator for the same reason — stripping it turns «۱٫۵» into ۱۵, a tenfold overcharge that looks exactly like what was typed.

### 45 — cost and pass-through are internal, and the client boundary is a type

A line carries `cost_rial` and `pass_through`, and neither may ever reach a client. `cost_rial` earns its place immediately rather than waiting for a profitability report: the margin on an offer has to be visible *before* it is sent, and an agency that cannot see its own margin on a media buy is guessing at whether the work is worth taking. That is why the screen's central column is حاشیهٔ سود and not merely one field among many.

The rule is enforced structurally rather than by comment. `agencyProposalClientView()` returns a type in which `costRial`, `passThrough` and `revenueCode` do not exist, and the test asserts the exact key set — so a screen built on the projection cannot render what it cannot name, and adding a cost field to the client shape fails a test. A comment saying "do not show the cost" survives one refactor; an absent property does not need to. `loadAgencyProposalClientView` is the service door that reads it from real rows, and #1127's proposal and service-quote print templates plus §A's P2 review portal are its consumers; no endpoint ships for it yet, because an endpoint with no consumer is dead surface.

`pass_through` is where §D's gross-versus-net question gets *answered*, though not where it gets posted. A media recharge is either the agency's own money moving through its accounts or the client's money moving past them, and that is a decision made line by line at offer time — the only moment anybody actually knows the answer — not something discovered at invoice time or inferred from how large a line is. A pass-through line must state its cost, because a recharge of an unknown amount is a promise to book the client's money without knowing how much of it there is. Nothing here reaches account 1270 and nothing posts; §D's invoice layer reads the flag when it is built.

A list row reports `costedLineCount` against `lineCount` so the screen can mark a margin «ناقص» when only some lines were costed. A margin over a half-costed offer is a guess with the missing inputs hidden, and printing it as a figure would look like an answer.

### 46 — frozen at `sent`, not at acceptance

A brief freezes at `confirmed`, because only then has the client agreed to something and only then does an edit make three downstream documents cite something they never read. A proposal freezes a step earlier, when it is sent, because it states a *price*: a client who reads «۵۰۰٬۰۰۰٬۰۰۰ ریال» and returns to find «۶۵۰٬۰۰۰٬۰۰۰ ریال» has been given a reason to distrust every later figure. That is 0260's rule for a submitted milestone — what an approver is reading cannot change underneath them — applied to the document an approver reads first.

The lines freeze with it, because the lines *are* the price. Replacing them on a sent offer is the same change by another route, and so is deleting the last one.

What stays writable is the status chain and its stamps, plus `contract_id` — the one commercial write that happens *after* the decision, for exactly the reason 0260 leaves `invoice_order_id` writable and 0274 leaves `project_id` writable. Freezing the outcome would make it unrecordable.

`accepted`, `declined` and `expired` are terminal, and that follows from the freeze rather than being a separate choice: the price closed when the offer was sent, so there is nothing left to revise in place. The client who declines at ۶۵۰٬۰۰۰٬۰۰۰ and is then offered ۵۵۰٬۰۰۰٬۰۰۰ gets a *new* proposal in the same series, and the declined one stays on the record as the offer that was actually refused — the only evidence of what the client said no to. Reopening it would destroy that. `withdrawn` does reopen, as a withdrawn brief does: an offer taken back before anyone decided was never a fact about the client. The screen makes the correction a button («پیشنهاد تازه از روی این») rather than leaving the member to discover it, and clears the contract and project pointers on the way, because a new offer is a new negotiation and silently inheriting this one's contract would attach a fresh price to a signed agreement.

Withdrawing an *empty* draft is allowed, and the exemption is the point of the rule rather than an escape from it: what is being prevented is an empty offer reaching the client, and withdrawing one shows it to nobody. The first version of 0276 refused it, which stranded a half-written draft — unable to be sent, unable to be withdrawn, deletable only while it was still a draft, a corner with one exit in it. Only the integration suite caught it, because the service and the schema each agreed with themselves and not with each other.

### 47 — two rules no CHECK can express

A discount larger than the subtotal it discounts would make the total negative: the agency paying the client to accept the work. No CHECK can refuse it, because it compares the header against the sum of another table's rows. Equal is allowed — zero-rial work is a real offer, a pro-bono campaign or a first month free to win a retainer — and the refusal is checked against the lines that will exist *after* the write, so patching only the discount or only the lines cannot sneak one past.

Accepting an offer whose validity has run out is refused for the same structural reason: `valid_until < now()` is not an immutable expression, so no CHECK can express it either. Without the refusal a client could accept a six-month-old quote at the old price, which is the exact mistake a validity date exists to prevent. `decline` and `expire` are *not* refused — recording that a client turned down an offer that had already lapsed, or formally closing one, are both accurate statements about the past.

Lapsing is computed from the date rather than read from the status, and the two are deliberately distinct facts. `expired` is a decision somebody recorded; lapsing is true the moment the date passes whether or not anyone has looked. A list that showed only the stored status would keep offering a quote that lapsed three weeks ago, because nothing had got round to marking it — so the screen has a «اعتبارشان تمام شده» filter that reads the date, and a sent offer can be `sent` and lapsed at once, which is exactly the case worth surfacing.

### 48 — same-timing triggers fire alphabetically, so the freeze and the arithmetic are one function

Postgres fires same-timing row triggers in alphabetical order by trigger name. The first version of 0276 had two functions on the lines — one computing the amount, one enforcing the freeze — and whichever sorted first answered. Both were individually correct, and together they meant that adding a badly-formed line to an already-sent offer could report the line's arithmetic instead of the fact that the offer is closed. Ordering by name is not a contract to build on, so the two became one function with the freeze first, and the comment says why, because the next person to split them will not otherwise know what breaks.

The same ordering fact produced two more fixes. Both line triggers run *before* Postgres enforces a CHECK, so a negative unit price was being reported as a violation of `amount_rial >= 0` — a true statement about a number nobody asked for, and a misleading answer to the person who typed it. And a revenue code outside the vocabulary was reported as missing from the tenant's chart of accounts, which sends the reader looking for an account that must not exist. Each trigger now refuses its own impossible input in words before deriving anything from it, and the CHECKs stay: they are the structural invariant and still hold if a trigger is ever dropped. This is the same reason 0274's trigger raises on a missing client rather than leaving it to `NOT NULL`.

None of the three was visible to a type-checker, to the unit suite or to a green whole-schema sweep. An 89-assertion raw-SQL harness found all of them, which is what it is for.


### 49 — the two hierarchy kinds are one relation, and that is why this is code

Decision 37 recorded that §A's multi-brand client needs no schema. What it did not say — because nothing had tried to read the edges yet — is that reading them is not a query.

`crm-relationship-service.ts` states the convention: `from → to` reads "from is *kind* of to". So `parent_organization` points **parent → child** and `branch_of` points **child → parent**. They are exact inverses describing the same fact, which means one hierarchy can be recorded in either direction, and a group's two brands can legitimately be recorded in *different* directions by two members on two days. A resolver that treated them as two relations would see a group with no brands, a brand with two parents, or nothing at all — depending on which way round somebody happened to type it.

So `crm-org-structure.ts` collapses both to one `child → parent` statement before anything else reasons about the structure. That collapse is the whole reason the module exists as code, and it is pure so it can be tested without a database: a resolver that only ever sees one direction looks correct in every unit test written against one direction, and fails in production on the first tenant that recorded it the other way.

### 50 — nothing here may assume the edges form a tree

Two members recording the same hierarchy from their own ends produce a cycle. A re-parenting recorded by adding an edge rather than removing the old one produces a brand with two claimed parents. Both are reachable in two clicks on the existing relationships card, so both are ordinary data rather than corruption.

The resolver is therefore total: any edge list produces a structure. Every walk is bounded by a visited set *and* by `ORG_DEPTH_LIMIT`, and each contradiction comes back in `conflicts` rather than being resolved silently. A card that quietly picked a winner would be the reason nobody ever fixed the record — and the CRM already has a data-quality screen whose whole job is surfacing records that need a decision.

Where a winner is unavoidable (a tree cannot give one node two parents) the newest statement takes it, because that is how a correction is actually recorded, and the superseded claim is reported beside it. A cycle names **only its own members**, not the whole path climbed to reach it: a brand three levels below a two-party loop is not part of the contradiction, and listing it would send a member to delete an edge that is correct.

The card renders *nothing at all* for a party that is not part of a group, which is the common case. An empty card on every customer file teaches people to skip this one, so «بدون برند» is not a state this screen has. That is different from an error and different from an empty group, and the payload says which.

### 51 — campaigns are not counted, and that is a schema finding

The card counts four registers per brand: `crm_deals.customer_id`, `agency_client_briefs.party_id`, `agency_proposals.party_id` (with the accepted ones separately) and `workspace_contracts.party_id`. All four name a client, so all four can be attributed to a brand.

**`growth_campaigns` names nobody.** It has `business_id`, `name`, `status`, `created_by` and its own version rows — no client column, in 0262 or in any later migration. So §A's "concurrent campaigns" cannot be presented per brand, and §C's agency's-own versus client-managed split is not blocked on a missing list endpoint as this document previously said: it is blocked on a missing *dimension*. That is a schema change, and it is §C's first job rather than its last.

Counting campaigns as zero was refused, and the integration suite pins the refusal: a card reading «۰ کمپین» on every brand states that no brand has campaigns, which is not what the data says. A missing figure and a zero are different claims, and only one of them is true here.

The card is not industry-gated. A corporate group with brands is not an agency idea — a wholesaler has the same shape — so, like §E under decision 32, this is gated by permission and not by trade. §A is the reason it was built, not a limit on who may use it.

**Corrected in wave 9, and the correction is about the diagnosis rather than the decision.** Everything above about refusing to render a zero stands, and the integration suite still pins it. What was wrong is the word *blocked*: this document said §C needed "a missing dimension" on `growth_campaigns`, as though the fix were an `ALTER TABLE`. Reading #901's builder showed that adding a client there would have been a mistake rather than a small extension — that table's trigger vocabulary is exactly `pos_sale_settled` and its reward is `cashback`, so its party is the shopper earning money back, not an agency's client (decision 52). The missing thing was a missing *record*, and wave 9 added one. §A's concurrent campaigns are counted per brand from it, with the in-flight subset broken out, and the test that pinned the absence now pins the presence.


### 52 — §C's campaign is a new table, and the name collision is the argument for it

There are four unrelated records in this product that the word «campaign» already names. `growth_campaigns` is #901's **retail cashback automation**: `CAMPAIGN_TRIGGER_TYPES` is exactly `["pos_sale_settled"]`, `CAMPAIGN_REWARD_TYPES` is exactly `["cashback"]`, and its base is `net_paid` — the party it rewards is the shopper, and creating one issues no reward, no liability and no journal entry. `message_campaigns` is an SMS broadcast with its own credit ledger. `media_review_rounds.campaign_id` points at the first of those, not at anything an agency runs for a client. And `ai_projects` has no client column at all, so §B's project cannot be the campaign either.

So 0278 adds `agency_client_campaigns` rather than extending any of them. The alternative — a client column on `growth_campaigns` — would have made one column mean two things in two trades, and the symptom would have been a report: a "campaigns by client" figure silently counting retail cashback automations, or an agency's media plan silently eligible to pay a shopper cashback. **A "missing column" diagnosis is only as good as the read of what the table is for**, and this wave's premise had to be overturned to find that out.

What the new table is: downstream of the brief (what the client asked for), the proposal (the priced offer), the contract (what was signed) and the project (the work), so it may point at any of the four — and it records the window, the channels, the media money out, and the figures that came back. `UNIQUE (business_id, campaign_number)` over a `CA-` series from the shared register numbering, RLS shape 1 with `ENABLE` + `FORCE`, and nothing in it posts.

### 53 — an overspend is recordable, and `over` is a state rather than an error

0278 has **no CHECK of `spend_rial` against `budget_rial`**. A campaign that cost more than it was budgeted for is a thing that happens, and a schema that refuses to store it does not prevent it — it pushes the true figure into a note, where no report can read it and no client conversation can be had about it. The refusal would not have made the overspend less real; it would have made it invisible.

So `agencyCampaignBudget` derives four states — `unbudgeted`, `under`, `at`, `over` — and the screen renders «فراتر از بودجه» with the amount past. `unbudgeted` is its own state rather than a zero budget, because "no budget was agreed" and "the budget was zero" are different claims about a client conversation.

The same reasoning sets `cancelled` apart from `completed` in the window rules: a campaign cancelled while still planned never ran, so demanding an end date from it would make a member invent a window to satisfy the schema. `completed` does demand one, because a campaign that ran has a date it stopped.

### 54 — every derived ratio is `null` when its denominator is zero

§C asks for spend, reach, CPL, CPA and ROAS with *defensible* attribution, and the word that does the work is "defensible". `agencyCampaignMetrics` returns `null` rather than 0 for every ratio whose denominator is zero, because a CPL of 0 on a campaign that recorded no leads reads as the cheapest leads the agency ever bought. §C's own phrase for that is "fake campaign performance".

ROAS needs *both* sides: `revenue_rial` is nullable, and null means "we do not know yet" where 0 means "we know it was nothing". A campaign with no revenue claim has no ROAS rather than a ROAS of zero, and the two render differently — «—» against ۰.

Two more refusals to pretend sit beside it. `metrics_source` has exactly two values, `manual` and `imported`, and that *is* the documentation: there is no ad-platform integration in this product, so a third value would claim a connection that does not exist. And attribution is a member's claim, with `metrics_note` holding the method, because a number with no stated method is not defensible — the field sits beside the figure it explains rather than on a separate screen.

### 55 — a nullable field needs four states, and this cost three test failures to find

0276's documented lesson is that a normaliser returning `null` for an *absent* field turns "omitted" into "refused": a PATCH carrying only a title would have cleared the budget. Avoiding that is not enough, and the first version of this wave's normalisers shows why. They returned `{ present, value }`, which cannot tell **"clear the budget"** from **"that is not a number"** — both look like `{ present: true, value: null }`. So `{ budgetRial: "" }` from a form whose money input the member had emptied was refused as `invalid_metric`, and the member could not remove a budget they had set by mistake.

`NullableFieldResult<T>` is therefore four states — `absent | clear | value | invalid` — with `nullableFieldStored()` collapsing them for the write. Whitespace-only counts as `clear`, not `invalid`: a form that emptied a money input hands back spaces.

The second failure in the same run is the same shape of mistake on a different axis. `updateAgencyCampaign` and `applyAgencyCampaignAction` computed `current` from `todayIsoDate()`, so a campaign whose window was in May reported itself not on air in November — true in production, useless in a test and in a report backfilling a date. Both now take `options.todayIso`. **A derived "today" must be injectable**, and the reason is not only testing: a report that reconstructs last quarter's calendar needs the same parameter.

### 56 — a freeze must exempt the changes the database makes on a parent's behalf, and a frozen record must still follow its client

Two exemptions, both found by a harness rather than by review, and both narrower than they first look.

**The cascade exemption.** 0278's freeze refuses any change to a closed campaign, and `ON DELETE SET NULL` on `brief_id` *is* an UPDATE of the child. So a completed campaign blocked the deletion of its own brief — and of its proposal, project and contract. The fix is not "NULL is fine", which would let a member un-file a campaign from its brief; it is to allow the clear **only when the parent row is gone**, checked per column, and the harness asserts both halves.

**The merge exemption, and it was a bug in shipped code.** 0274 freezes a confirmed brief and 0276 freezes a sent proposal, and both put `party_id` inside the frozen-substance comparison. That is right for an edit and wrong for a merge, and the two are not the same operation: an edit says "the client agreed to something different than we recorded", which a confirmed brief must refuse; a merge says "these two client records were always one", which changes no agreement and only re-points whose file the document lives on. The result was that `mergeCustomers` — which re-points every reference the registry classifies as `move`, and a brief's client is NOT NULL so it cannot be left behind — failed with a raw `23514` on the CRM's own duplicates screen as soon as either client held a confirmed brief or a sent proposal.

0279 follows 0217 rather than inventing a door. `journal_immutable_columns_guard` already drew this line: substance immutable always, attribution movable only while the transaction has declared `app.ledger_party_move = on` — a flag the merge loop sets for a reference that declares a `preMoveSql`, after that statement has written its audit row. So the move lands in the new `crm_party_attribution_moves` first, the door opens for exactly that registered move, and every other session still hits the guard. The flag's name is historical and kept for the reason `register-numbering.ts` keeps its `aec-number:` namespace; the audit table is *not* shared with the ledger's, because a brief is not a journal line.

0278 was born with the split rather than patched into it, because a new table has no business shipping a bug this wave just spent a migration fixing. Neither 0274 nor 0276 was edited in place: an applied migration's checksum is in `schema_migrations`, and amending forward is the only change that reaches an install that already ran it.

**The lesson is about the sweep.** `party-merge-coverage` passed throughout, because it checks that every `parties(id)` reference has a *declared disposition* — not that the declared move survives the table's own triggers. A green whole-schema sweep can be vacuous in exactly the dimension a new feature stresses, and the only thing that found this was executing a merge against a frozen document.

### 57 — the CRM section is `client-campaigns`, because Growth owns the word `campaigns`

`app-ownership.test.ts` asserts that the CRM's nav contains no key called `campaigns`, and that Growth's does. That is the app-ownership split doing its job: the test exists to stop one app growing a second copy of another's territory, and wave 9 walked straight into it by naming a new CRM section `campaigns`.

The boundary is right and the fix is not to negotiate with it. Growth's campaign is #901's retail cashback automation (decision 52) and this record is an agency's media plan for a client — genuinely different things that happen to share an English word. Two names is the honest resolution; one name with a comment explaining the difference is the dishonest one, because the comment is the only thing standing between a member reading «کمپین‌ها» in two apps and having to know which is which.

So the key, the route, the API path and the screen file are all `client-campaigns`, and the Persian label stays «کمپین‌های کارفرما» — which already carried the distinction, and is what a member reads. The command palette keeps «کمپین» pointing here rather than at the brief, where it had been sitting as the nearest available thing; Growth's own campaigns are reached by their own aliases and by the Growth door.

The lesson is the one decision 51's correction already implies, from the other direction: a new section key is not one change. It reaches the permissions table, the nav and its group, the command aliases, the knowledge base's help title, the section switch, the permission test's route table, the coverage map — and the app-ownership boundary, which is the only one of those that can say *no* rather than merely needing an update. It is also the only one a compiler cannot see, and a full-suite run is what caught it.

## Sites audited and deliberately left alone

The issue asks for every enumeration to be audited, so these are recorded rather than left to a
reader's guess:

* **`/api/industry/items/[id]/audit`** guards on `industry === "food_service"` and therefore admits
  the agency, AEC and `service_saas` — three trades with no `items` rows. It fails safe (the item
  lookup is branch-scoped, so a caller gets 404), and tightening it to `isRetailCatalogueIndustry`
  would change the status code two *shipped* trades return for a legacy-data audit. Left as is; a
  candidate for #1081's route-guard sweep rather than for this wave.
* **`REPORTS_TABS`** (`src/app/dashboard/reports/reports-nav.ts`) has no industry axis, so an
  agency's «گزارش‌ها» submenu still lists «سفارش‌های شیفت» — the current shift's sales and orders,
  which a business with no till never has. It is the one shop word left in the agency's rail, and
  `tenant-navigation.test.ts` names it as a single, pinned exemption rather than filtering it out of
  the assertion: the tab list is shared by the sidebar, the in-page rail and the reports page so the
  three cannot disagree, its contract is "a tab is shown exactly when its API would answer", and the
  same entry is wrong for the two other service trades (AEC, `service_saas`), whose `pos` is
  likewise only the address of their invoice screen. Hiding it is
  therefore an industry-aware-UI decision across three shipped trades — #1081's sweep, not this one.
  Fixing it there fails the exemption test, which is the reminder to delete it.
* **`src/lib/mcp/registry.ts`, `notification-authorization.ts`, `data-transfer/registry.ts`** branch
  on `architecture_construction` for AEC's own modules, tables and reminder keys. The agency has
  none of those in this wave, so there is nothing to add — and `mcpTenantEnabledModules` derives
  from the profile, so the agency's MCP surface follows its modules automatically.
* **Payment methods** (`payment-methods-service.ts`) branch on `food_service` only; the agency gets
  the same built-in ways every non-F&B trade gets, with SnapFood retired.
* **AI task presets** (`ai-tasks.ts`) restrict four presets to `food_service` and gate the rest by
  module and permission, which the new profile answers correctly with no edit.
* **Print templates** (`printing/template-catalog.ts`) derive eligibility from `hasModule`/
  `hasCapability`. Barcode, repair and serialized-retail templates stay out by construction — the
  trade claims no capability. Since decision 8 the trade *is* a member of the derived
  `POS_INDUSTRIES`, so the receipt/invoice templates are eligible for it: that is the document its
  invoice screen writes, on the same terms AEC and the service company have. Agency-specific
  documents (proposal, service quote, creative brief, statement of work, campaign report) are
  #1127's gallery, per the issue's own "integrate rather than duplicate".
* **The other four `listTemplates` callers** — the phases route's "apply template", the autopilot's
  `projectPhaseCreate`, the AI tool `list_workspace_templates`, and `workspace.ts`'s own
  `resolveTemplate` — keep calling it without a profile. Three of the four look a template up *by
  key*, where ordering cannot matter; the fourth is the assistant's list, which is profile-less for
  AEC today too, so wiring the agency there and not AEC would have made the two trades disagree.
  Making the assistant's answer match the dialog's is one small change across both, and it belongs
  with the AI surface (#1140) rather than with a business type.
* **The MCP write registry gains no agency verb.** AEC has `aec.profile.save` because its profile
  presets nineteen capabilities its screens and APIs enforce, so an assistant changing it changes
  what the business can do. The agency's preset orders seven blueprints; a write verb for it would
  be an assistant reshaping a settings screen nobody asked it to reshape, and it would need its own
  risk and approval classification. `/api/settings/agency-profile` is classified by the coverage
  map's existing `settings` prefix — `docs/mcp/coverage-matrix.md` was regenerated (route count
  1132 → 1133) and nothing else in it moved.
* **`industry-coverage.test.ts`'s source scan** passes unchanged: the wave adds no hard-coded
  industry list anywhere in `src/`.

## Tests

Unit (`npx vitest run`, whole suite green — 1288 files / 16013 tests after the merges of `main`'s
#1171 and #1174, 1285 / 15970 after #1171 alone, 1281 / 15929 at wave 3's own tip, 1256 / 15604 at
the wave-2 merge commit, 1243 / 15435 after wave 2, 1241 / 15407 after wave 1; each jump is mostly
`main`'s own new tests):

* `coa-template.test.ts` — the trade's eleven accounts, their side of the book and their parent
  heading; no hospitality account and no 1230; exactly one «پیش‌دریافت» liability; 1300 and 5600
  present with 5600 outside cost of sales; template returned by identity.
* `industry-profile.test.ts` — brand of its own, the forbidden module list, all four tenant apps
  reachable and no `workspace`/`projects` module key, agency nouns with no «منو»/«سفارش»/«کالا» in
  any of them, flags off, no capability, no `retailDefaults`, registration in the three registry
  surfaces, and — after #799's service invoice reshaped the assertion — the trade's `pos` module
  proven to be the invoice screen and nothing more (it is in `SERVICE_INVOICE_INDUSTRIES`, and the
  four modules a counter would need are filtered out of its module list).
* `wizard-steps.test.ts` — the `service` shape, no `aec_profile` step, required steps
  `business/accounts/tax`, no catalogue pointer.
* `accounting-posting-rules.test.ts` — the settings panel's inventory code matches the posting
  engine's copy and exists in the chart; the sale rule credits 4640 and names 4650/4660/4670, 5197
  and 5600; cost of sales leads with 5196 and contains neither 5600 nor 5100.
* `industries.test.ts` — the counter-loss caution in both directions.
* `account-classification.test.ts` — 2140 is a trade payable; 1270 and 1385 have no role.
* `industry-coverage.test.ts` — the CI guard: unique label, offered by the wizard, branded profile,
  valid chart carrying its own cost-of-sales list and inventory account, rules posting only to
  accounts the chart carries, wizard starting at the beginning, at least one app; the newest
  `businesses_industry_check` naming all twelve industries exactly once; and the two service trades
  pinned to their family so the fall-through cannot move one.

Wave 2:

* `agency.test.ts` — the eight presets in the issue's order and inside one enabled key (none of them
  is a thirteenth industry); Persian, unique labels; the `full_service` default; a vocabulary
  disjoint from AEC's eight, so «contractor» is not an agency preset and «media_buying» is not an
  AEC one; the two mechanical proofs that a preset cannot authorize (the module imports nothing but
  `./industries`, and a definition carries exactly `key`, `label`, `description`); the seven
  blueprints — keys, industry, phases, the two control points, no shop vocabulary, real presets
  recommended and no preset left without a blueprint; and the stored-setting reader, which answers
  `null` rather than a coerced default for anything it does not recognise.
* `tenant-navigation.test.ts` — the P0 checklist's "RTL sidebar", as a contract on the function that
  builds the rail rather than on markup: an agency's entries all belong to a module the trade has,
  there is **exactly one** selling entry (the invoice screen, under the trade's own noun) and no
  till, orders board, menu, floor or warehouse, no shop word in the copy (one pinned exemption,
  above), and all four tenant apps are reachable. The same module assertion then runs for all twelve
  industries, so the next trade inherits it.
* `workspace-shared.test.ts` — the seven agency blueprints are offered to an agency and to nobody
  else, neither trade's set leaks into the other, the generic families survive, an agency preset
  orders its blueprints first without hiding the rest, and a preset from the other industry badges
  nothing.
* `audit.test.ts` — the new settings action is labeled in Persian, not shown as a dotted key.

The merge (decision 8) added and reshaped five more:

* `service-invoice.test.ts` — the trade set is exactly three, the agency's default revenue is 4640,
  its list is exactly 4640/4650/4660/4670 and each is a `revenue` account its own chart seeds, and
  neither another trade's revenue nor the agency's own cost, pass-through or marketing codes (5196,
  1270, 2430, 5600) can be credited as revenue.
* `accounting/service-invoice-nav.test.ts` — the third case: an agency owner's Accounting sidebar has
  the «فروش و درآمد» group with one entry, «صورتحساب و دریافت» → `/accounting/pos`, and no café,
  stock or open-orders entry; an accountant, who cannot take payments, still gets no sales group.
* `industry-profile.test.ts` — the agency block now pins `pos` *as* the invoice screen (the trade is
  in `SERVICE_INVOICE_INDUSTRIES`, and filtering its module list for `orders`/`stock`/`menu`/
  `inventory` yields nothing) instead of pinning the module's absence, and the shared assertion that
  replaced `POS_LESS` runs for all twelve trades.
* `industry-coverage.test.ts` — `SERVICE_INVOICE_INDUSTRIES` joined `REGISTRY_SETS`, so the
  restated-industry-list scan accepts it as a set of its own rather than through the allowlist.
* `retail-invoice-screen.tsx`'s own tests keep passing unchanged, which is the point of typing
  `ServiceLineForm` on `ServiceInvoiceIndustry` rather than on a pair of keys.
* `agency-commercial.test.ts` (**wave 3**, 43) — the pure module §D's registers are built on: the
  two status chains and every legal and illegal move in them; the act catalogue, including which
  chain an act belongs to (both registers share four status *names*, so `isAgencyMilestoneStatus("draft")`
  is also true of a change request's draft and the chain must be named at the call site, never
  inferred from the status); `price` versus `reprice`, which share a target and are told apart by
  where they come *from*; the schedule splits, with a three-way split of 100% summing to exactly
  100 and an amount split putting the remainder on the last share; retainer periods; the
  revised-value arithmetic including a negative descope and a refusal of zero; and the margin's
  refusal to guess when either posted figure is unknown. Two structural assertions hold the module
  honest: it imports only `./digits` and `./service-invoice`, and it contains no permission, role or
  capability string — a module that decides who may approve a figure must not be able to reach a
  database or invent a gate.
* `api/agency/guard.test.ts` (**wave 3**, 7) — the error map's three vocabularies (the agency
  service, the invoice engine, and the workspace project gate underneath both), with the status
  table typed as a `Record` over the union of all thirty refusal codes so a new one stops the file
  compiling until its status is chosen deliberately rather than arriving as the map's `?? 400`
  default. The invoice engine's three refusals are asserted with the Persian sentence each was
  raised with.
* `api-guards.test.ts` and `billing/catalog/audit.test.ts` (**wave 3**) — the two inventories a new
  top-level API segment has to join: `agencyOwner(PERMISSIONS.workspace…)` is recognised as a
  canonical tenant guard (it delegates to `workspaceOwner`, so it is a *stronger* guard than the AEC
  one — these routes cannot write while the tenant's projects service is deactivated), and the
  `agency` segment classifies as `operations.shared` beside `workspace` and `aec`, because the money
  these registers move is already declared by `orders`/`sales` and `ledger` and billing it again
  would bill twice for one document.

Database (`npm run test:db`, needs `DATABASE_URL`):

* `integration/business-industry.integration.test.ts` — provisioning stores `advertising_agency`
  (the constraint migration is what makes that possible), seeds the agency chart and none of the
  café's, keeps the shared controls, turns `inventory`/`reservations`/`delivery` off, treats the
  console provision as a complete setup (no menu step), and switches a jewellery tenant into an
  agency **additively** — every pre-existing account keeps its id and name and the seeded list is
  exactly the difference.
* The same file's wave-2 block covers the preset against a real database, because three of its
  properties are only real there: the round trip survives RLS on `settings`; a jewellery tenant is
  refused (`industry_mismatch`) on both read and write and gets no row; an unknown preset is refused
  (`invalid_profile`) and stores nothing; the save writes the audit row with what changed *and* what
  it changed from; and the stored preset is what orders the blueprint list — all seven before the
  generic families on the default, and «کمپین تبلیغاتی جستجو و اجتماعی» plus «کمپین محیطی، چاپ و
  تولید» badged first for a media buyer, with the other five still offered.
* `integration/service-invoice.integration.test.ts` — the merge added an agency block beside the
  contracting and service-company ones, against a chart seeded with the agency's own four revenue
  accounts and none of the other trades': a retainer, a media recharge and a video production on one
  credit invoice land in 4640, 4660 and 4650 respectively with the whole invoice on receivables, VAT
  in 2200, the books at zero and exactly three `service_sale_revenue` entries — no COGS, because
  there is no stock to relieve; then 4670 is accepted and 4610, 4500, 5196, 1270, 2430, 9999 and a
  stocked line are each refused.
* `integration/agency-commercial.integration.test.ts` (**wave 3**, 17) — §D's billing documents
  against a real database, on a tenant provisioned through the product's own path so its chart is the
  trade's real one rather than a list the test invented. It covers only what a database can prove: a
  schedule laid out from a base and numbered per project (and each project's series starting again at
  `MS-001`); a percentage resolved at invoice time against the revised value with the signed contract
  value read back from the row to prove nothing rewrote it; the invoice arriving as one balanced
  entry credited to the account the milestone named, tagged with the project's own dimension, with the
  receivable in 1200 and the trial balance at zero; approving alone leaving the order book and the
  ledger empty *and* the posted half reading null rather than zero; the engine's self-approval refusal
  holding against a register that writes its own queue row, with a withdrawal returning the row to
  where its author can edit and send it again; migration 0260's guards as database facts — a frozen
  submitted row, a percentage and an amount refused together, a revenue code the tenant's chart does
  not have refused, only a draft deletable; a descope carried as a negative figure, refused on the
  way out under its own code when the days it moves the schedule by are missing and then editable
  again so its author can supply them (decisions 23); and a supplier's subcontract on the same
  project ignored when the engagement is chosen, because §D's contracted value is what the client
  agreed to pay.

  This file is also the reason decisions 22 and 23 exist. It cannot run without a Postgres, so CI's
  integration shard was the first execution of any of it — and the first execution of the service
  against a real database found both faults, neither of which a unit test on mocked rows could have
  reached.

* `media-review.test.ts` (42) — the pure module: every legal and illegal round transition, both
  freeze predicates against each status, `reviewRoundStateFromItems` including the null-while-undecided
  and rejected-outranks cases, TTL clamping, expiry, revocation beating expiry, token shape and
  display prefix, both act catalogues, and the progress string. A source scan asserts the module
  imports `./digits` and nothing else.
* `review-guard.test.ts` (7) — the error map is typed `Record<MediaReviewErrorCode, number>`, so
  adding a refusal code without giving it a status fails the compiler rather than defaulting to 400.
* `integration/media-review.integration.test.ts` (18) — the whole flow against a real database on a
  `jewelry` tenant, which is what proves §E is not industry-gated: minting and revoking, the trail
  never rewritten, withdraw revoking live links in the same act, progress and live-link counts in the
  list, and two tenants kept out of each other's reach. Link expiry is tested by disabling
  `media_review_links`' user triggers through a `pg_trigger` lookup, moving `expires_at`, and
  re-enabling them in a `finally` — 0265 freezes the stamp on a live link, so it cannot be updated
  directly.

Two faults only a real database could find, and both are recorded as decisions: the service had no
`business_id` predicates at all and passed every unit test because the harness connects as the `pos`
superuser, which bypasses RLS even under FORCE (decision 31); and the purpose gate refused a `review`
link every byte fetch, which made the default link unable to show the artwork it exists to show
(decision 28).

* `agency-brief.test.ts` (26) — §A's brief vocabulary: the chain and every
  transition it refuses (no confirming a brief nobody was shown, no un-confirming
  anything), `agencyBriefActionsFrom` offering only acts the route would accept,
  the freeze covering `confirmed` and `superseded` but not `sent`, deletion only
  from `draft`, an objective required only from `sent` onwards, channels deduped
  into vocabulary order and *refused* rather than dropped when a key is unknown,
  deliverables validated against §E's format vocabulary including `brief` itself,
  a budget read as absent rather than as zero, and text trimmed but never
  truncated.
* `integration/agency-client-briefs.integration.test.ts` (17) — the same feature
  against a real database: one `BR-` sequence per agency held under two
  concurrent creates, a separate agency starting its own `BR-001`, a second tenant
  answered `brief_not_found` for load, list, patch, transition and delete,
  references into another tenant refused with nothing written, §A's approver rule
  in both directions and against a stranger, the chain walked end to end with a
  confirmation attributed to the approver already on the brief, an unattributed
  confirmation refused, withdrawal from either side with `sent_at` surviving, the
  freeze refusing six kinds of edit while the project pointer and the note still
  move, absent-versus-null on a PATCH, an impossible date window refused on create
  and on a one-sided patch, draft-only deletion, a client's deletion cascading a
  confirmed brief away, and every list dimension including a search across the
  brief's own words and its client's name.
* 48 assertions run directly against `0274_agency_client_briefs.sql` over
  Postgres — the CHECKs by name, both triggers, the cascade, and the two `SET
  NULL` pointers. Each negative case asserts *why* it was refused, because a
  refusal from the wrong constraint is still a refusal and still a bug. This is
  what found the frozen `project_id` and the `BEFORE` trigger answering a NULL
  client before the column's own NOT NULL could.
* `agency-proposal.test.ts` (34) — §A's proposal vocabulary: the chain with every
  decision terminal and only `withdrawn` reopening, `agencyProposalActionsFrom`
  offering only acts the route would accept, the freeze covering everything past
  `draft` and saying so separately about the lines, lapsing computed inclusively
  from the date and never applied to a decided offer, `accept` blocked once an
  offer has lapsed while `decline` and `expire` are not, the revenue accounts read
  from the trade's own list rather than restated, the amount rounding half up
  exactly as Postgres rounds `numeric`, zero kept as a real rial figure rather
  than collapsed into absent, a fractional quantity surviving a browser's
  floating-point artefact, a date refused unless it is a plain `YYYY-MM-DD` inside
  a Gregorian year range, lines renumbered in the caller's order and refused
  rather than dropped, a pass-through line required to state what passes through,
  totals taxing what is left after discount and capping a discount at the
  subtotal, margin subtracting the discount but never the tax, and the client
  projection asserting its exact key set so a cost cannot be added to it.
* `integration/agency-proposals.integration.test.ts` (27) — the same feature
  against a real database: one `PR-` sequence per agency held under two
  concurrent creates and a second agency starting its own, a stored amount equal
  to the pure module's on the half-rial case, totals derived with no total column
  present in the schema at all, a margin visible to the agency and provably absent
  from the client projection read from real rows, a draft refused to the client
  door, a discount past the subtotal refused on create and on a one-sided patch in
  either direction, a pass-through line without a cost refused, a revenue code
  outside the vocabulary refused, a second tenant answered `proposal_not_found`
  for load, client-view, list, patch, transition and delete with nothing changed
  by the attempts, §A's stakeholder rule in both directions and against a stranger
  who is somebody else's contact, one client's brief refused as another client's
  price, the chain walked end to end with a decision attributed to the stakeholder
  already on the offer, an unattributed decision refused, an empty offer refused
  at `send` but allowed at `withdraw`, the freeze refusing eight kinds of edit
  while the contract pointer still moves, `accept` refused once lapsed and allowed
  on the last valid day, a list whose margin equals the opened row's, every list
  dimension including `lapsedOnly` and a search across the offer's words and its
  client's name, absent-versus-null on a PATCH, draft-only deletion cascading its
  lines, a client's deletion taking a sent offer with it, and a brief's deletion
  leaving the offer that priced it standing.
* `crm-org-structure.test.ts` (19) — §A's organisation resolver: both hierarchy
  kinds collapsing to one `child → parent` statement, a refusal of every kind that
  is not a hierarchy so a contact cannot become a brand, a group read from its own
  file and from one of its brands (where the sibling appears, because seeing the
  other brand is what stops one brand's work being priced for the other), three
  levels root-first and depth-ordered, a hierarchy recorded in both directions
  resolving as one tree, `isEmpty` for a party nothing hierarchical touches, an
  unrelated group ignored, a missing name left blank rather than invented, the
  newest of two claimed parents winning with the superseded one reported, an
  undated claim outranked by a dated one in either arrival order, two- and
  three-party cycles terminating and naming only their own members, and both the
  upward and downward walks stopping at the depth bound and reporting that they
  did.
* `integration/agency-org-structure.integration.test.ts` (12) — the same reading
  against a real database: one group resolved from edges recorded in both
  directions, a brand's file rooted on its group with its sibling visible, three
  levels depth-ordered, each brand's deals/briefs/proposals/accepted/contracts
  counted against that brand and nobody else's with the group itself carrying
  nothing (rolling up would double-count every figure on the card), a campaign count
  — **pinned as an absence in wave 8 and inverted in wave 9**, so the change was a
  decision somebody made rather than a column that appeared, a contact-only
  party reporting `isEmpty`, a second tenant answered `null` for a valid foreign id
  and unable to pull a foreign party into the tree through a join or a foreign deal
  into the counts, a nonexistent and a malformed id both refused, the newest of two
  claimed parents winning with both groups drawn, a cycle terminating with a party
  below the loop correctly excluded from it, the depth bound, and a `contact_of`
  edge not making a person a brand.
* 89 assertions run directly against `0276_agency_proposals.sql` over Postgres —
  the named CHECKs, the absence of auto-named ones, both unique keys, the
  composite line foreign key, four triggers, RLS enabled *and forced* on both
  tables, and the two non-vacuity checks that matter most: that no total column
  exists on the header and that cost and pass-through exist only on the lines.
  Each negative case asserts *why* it was refused. This is what found the
  alphabetically-ordered triggers, the negative price reported as a bad
  `amount_rial`, and the out-of-vocabulary revenue code reported as missing from
  the chart — none of which a type-checker, a unit suite or a green whole-schema
  sweep can see.

* `agency-campaign.test.ts` (26) — §C's campaign vocabulary: the chain with both
  terminal states and no path back to `planned`, the acts derived from it, the
  window each act implies, `isAgencyCampaignInFlight` counting a paused campaign's
  budget as still committed, `isAgencyCampaignCurrent` inclusive at both ends and
  only for a campaign in flight, the four metrics with **every ratio null on a zero
  denominator** and ROAS needing both sides because "we do not know" and "it was
  zero" are different claims, the four budget states with `over` first-class, a
  reversed window named rather than inferred, and the normalisers — including the
  four-state nullable result (decision 55), channels de-duplicated in first-mention
  order with the cap checked *before* the dedupe and an unrecognised channel refused
  rather than silently dropped. Dates reuse `src/lib/iso-date.ts` rather than adding
  a fifth validator, and a Jalali year is refused by bounds because `isValidIsoDate`
  is calendar-shaped rather than calendar-correct.
* `integration/agency-client-campaigns.integration.test.ts` (16) — the same feature
  against a real database, which is the only place a service and a schema can be
  caught disagreeing while each is self-consistent: one `CA-` sequence held under a
  race, the defaults, refusals arriving in words, an overspend recorded *and*
  reported as `over`, the four ratios and their nulls with `revenueRial: 0` giving no
  ROAS, **list-row figures identical to the detail row's** (a list must not print a
  figure it did not read), the five filters, a one-field patch clearing nothing while
  an explicit clear still works, a figure pair validated against the record rather
  than against the request, the full lifecycle with each window requirement stated in
  words before the CHECK could say it, a closed campaign refused from the service and
  from a **raw `UPDATE` that skips the service entirely**, deletion only while
  planned, a second tenant answered null and refused, a foreign client refused by the
  trigger as `23514`, §A's cross-brand brief arriving the same way, and two of one
  brand's campaigns concurrent in one window — neither current once it has passed.
* `integration/agency-party-merge.integration.test.ts` (6) — decision 56's merge
  door, and the shape of the fix rather than only that a merge passes: relaxing a
  freeze is easy and dangerous, so each test asserts both halves. A confirmed brief,
  a sent proposal and a completed campaign each follow their client onto the
  surviving record with the substance untouched and the proposal's lines byte-for-byte
  intact, a brand's approver and stakeholder come along so §A's separation rule
  survives, every move is audited into `crm_party_attribution_moves`, and an edit
  that is *not* a merge is still refused — as is the substance, flag or no flag.
* `campaign-guard.test.ts` (6) — §C's error map, whose value is the type rather than
  the assertions: `EXPECTED_STATUS` is `Record<AgencyCampaignErrorCode, number>`, so
  adding a refusal to the service without deciding its status fails `tsc` before it
  can reach a route. The statuses are pinned too, because the screen renders «این
  کمپین بسته شده است» off the 409s and renumbering one to a 400 would make it
  re-show an editable form for a record that cannot be edited.
* 66 assertions run directly against `0278_agency_client_campaigns.sql` over
  Postgres — the named CHECKs and the deliberate absence of one between spend and
  budget, both unique keys, the five reference foreign keys and their `SET NULL`, the
  two triggers, RLS enabled *and forced*, and the non-vacuity checks: that
  `metrics_source` has exactly two values and that there is no third. This is what
  found the cascade exemption — a freeze that refuses "any change to a closed row"
  also refuses the `ON DELETE SET NULL` a parent's deletion performs on it, so a
  completed campaign was blocking the deletion of its own brief.

* `crm-agency-pipeline.test.ts` (13) — §A's preset: both invariants
  `savePipelineStages` enforces, so the preset can never be refused by the
  function that writes it; exactly one `won` and one `lost`; contiguous ordering;
  unique names within the column's 120 and notes within its 300; probabilities in
  range and rising to `won`, because a forecast multiplies by them and a preset
  that fell as a deal advanced would reward stalling; no `legacy_key` anywhere;
  only `advertising_agency` receives it; and a source scan proving it imports
  nothing but a type.
* `integration/crm-agency-pipeline.integration.test.ts` (8) — the preset against a
  real database, which is the only place the interaction with the tenant's
  existing pipeline is visible: it lands beside the default rather than replacing
  it, creating it twice writes it once, two simultaneous first visits produce one
  pipeline, the default keeps its identity and its seeded six still active with
  zero deactivated stages anywhere in the tenant, a `jewelry` tenant gets nothing
  written at all, no agency stage carries a `legacy_key` while every seeded one
  still does, the two invariants hold as rows, and a stage the agency renamed
  survives the next visit.

The count of zero deactivated stages is the assertion that justifies the file.
Composing `createPipeline` with `savePipelineStages` — the obvious implementation
— type-checks, passes every unit test, and leaves six deactivated copies of the
default's stages beside the seven agency ones, because the first copies the
source stages and the second deactivates rather than deletes what it is not
given. Only a real database shows the wreckage (decision 35).

## Rollout checklist

1. Merge; the migration is forward-only and applies in filename order. `main` has since added two
   more `0259_*` files (`kavenegar_funding_templates_reconciliation`,
   `workspace_document_revision_chain`), so `0259_advertising_agency_industry.sql` now sorts *first*
   of the three — harmless, because it widens one CHECK constraint and touches nothing the other two
   touch, and the repository already ships repeated numbers (two `0257_*`, four `0258_*`). Renumbering
   to `0260_*` was considered and rejected: the number is not load-bearing, `scripts/migrate.ts`
   sorts filenames, and `industry-coverage.test.ts` selects the migration by *content* (the newest
   one carrying `businesses_industry_check`), which is still this one.
2. Fresh install: `npm run db:migrate`, then create an agency from `/welcome` — the picker offers
   «آژانس تبلیغاتی», the wizard walks seven steps, the accounts step proposes the agency chart.
3. Upgrade: `npm run db:migrate` on the production database. The constraint is dropped and re-added
   wider; no row is touched and no business is reinterpreted. Re-running is safe.
4. Console: provision an agency from `/platform/businesses` and open it — the sidebar brand reads
   «آژانس تبلیغاتی», the rail shows the four apps with exactly one selling entry («صورتحساب و
   دریافت» → `/accounting/pos`), and there is no orders board, no menu and no products workspace.
5. Console: switch a *test* business from a retail trade to the agency and read the confirmation —
   it must name the lost counter, and the account list afterwards must be the union of the two
   charts.
6. Verify the refusal paths: a WooCommerce/CMS order ingest for an agency connection fails with
   `industry_not_storefront` rather than creating `items` rows, and a *stocked* line on the agency's
   own invoice screen is refused — its line-kind list is `["service"]`, so the trade cannot sell a
   shelf it does not have. `/api/sales` itself is not refused: it is the invoice endpoint (decision 8).
7. Smoke one agency document end to end: from «صورتحساب و دریافت» write a service invoice with a
   retainer line (no account chosen → 4640) and a media recharge (4660), take it on account against
   a client, then add a purchase/expense debiting 5197 and read the gross-profit line in the income
   statement — it must have moved by the client cost and not by 5600.
8. Tenant, as an owner: «تنظیمات ← کسب‌وکار و شعبه» shows «پروفایل فعالیت آژانس» for an agency and
   for no other trade. Pick «خرید رسانه و تبلیغات عملکردی», save, and confirm the audit tab reads
   «تغییر پروفایل فعالیت آژانس». Re-open the section: the choice is still there.
9. Then open My Workspace → «قالب‌ها» (or the project dialog's template picker) and confirm the
   seven agency blueprints are listed, that «کمپین تبلیغاتی جستجو و اجتماعی» and «کمپین محیطی، چاپ و
   تولید» carry «پیشنهادی» and come first, and that the other five are still offered. Create one
   project from a blueprint, rename a phase and delete a starter task: the blueprint must not fight
   the edit.
10. As a member *without* `settings.manage`, confirm `GET /api/settings/agency-profile` is refused
    while the blueprint list still renders — reading an ordering is `workspace.view`, changing it is
    a settings write.

## What this change does not build

Deliberately, and each is named in the issue:

* **§A CRM** — contract renewals, and scope of work as a document rather than as prose. The
  agency-shaped pipeline shipped in wave 5, the client briefs in wave 6, the proposals and quotes in
  wave 7 (with §D's estimates, which are the same document — decision 43), the multi-brand client
  presentation in wave 8 (decisions 49–51), and wave 9's client campaign record, which is §A's
  "concurrent campaigns" and §C's first half at once (decisions 52–56). Canonical `parties`/leads/deals already existed, and
  decision 37 records why the multi-brand account needed no schema. A proposal carries
  `scope_of_work` and `terms` as text, which is what a client reads and disputes; a separately
  versioned scope document with its own approvals is #1127's print-template territory and is not
  built. Contract renewals are `workspace_contracts`' `reminder_days`, start and end dates with
  nothing acting on them.
* **§B My Workspace** — wave 2 added the seven project templates and the agency stages they carry.
  Still missing: deliverable revisions and version history, the approval/request-changes states as
  an agency-shaped review (Workspace has approvals; nothing here wires a client-facing review to
  them), the typed agency metadata §B asks for in small extensions (client campaign, channels,
  brief, deliverable type, formats, revision counts, publication windows, acceptance criteria),
  resource scheduling and capacity for designers, copywriters, media buyers and production
  freelancers, and any client/external reviewer access — which, if it is ever built, must be scoped
  and revocable, never a share URL that bypasses tenant and project authorization. #1110's
  eligibility matrix must still name this trade when it lands.
* **§C Growth** — campaign calendar and channel mix for *client* campaigns, the agency's-own vs
  client-managed split in reporting, spend/reach/CPL/CPA/ROAS with defensible attribution, manual
  import of platform data. No external ad-platform integration is claimed or implied anywhere in
  this change. Wave 9 built the **record** half and stopped there: `agency_client_campaigns` now
  names a client, holds the window and the channels, holds the media spend and the five attribution
  counts, and derives CTR/CPL/CPA/ROAS with every ratio null on a zero denominator (decisions 52–54).
  What is *not* built is the reporting half — a calendar view across campaigns, the agency's-own
  versus client-managed split (which needs a "whose campaign is this" dimension that no record here
  carries, and which the issue's own non-goal rules out inventing), cross-campaign CPL/CPA/ROAS
  roll-ups, and manual import of platform data as a file rather than as typed figures. Wave 8's
  claim that §C was "blocked on `growth_campaigns` having no client column" is corrected in decision
  51: that table is #901's retail cashback automation and could not be given one honestly, so the
  missing thing was a record and wave 9 added one.
* **§D Accounting** — wave 2 gave the trade its ordinary sale document (a service invoice, on account
  or settled, one line per described service, each crediting one of the agency's four revenue
  accounts, posted by the existing `service.sale_revenue` rule), and wave 3 gave it the documents
  that decide what to ask for: milestone, deposit, retainer and hourly billing schedules, change
  requests that revise an engagement's value, and the campaign/project P&L with its booked half kept
  apart from its posted half. Client receivables arrive through the invoice itself — an agency
  invoice defaults to on account (نسیه), so the posting engine raises the receivable and §D's
  collected/owed split is read from the invoices a project produced. What is still missing:
  * ~~**Estimates and quotations.**~~ Built, as `agency_proposals` (0276) — the pre-contract document
    that prices work the client has not yet agreed to, carrying a nullable `contract_id` written
    after acceptance so the path from a quotation to a signed engagement exists. Decision 43: §A's
    "proposals/quotes" and §D's "estimates" are one document, because §B's stage list puts them in
    one place. What is still missing on §D's side is the *posting*: an accepted proposal is an
    agreement that money will become due, and turning it into an invoice is the service-invoice
    layer's act, not this table's.
  * **True customer advances.** A `deposit` is a milestone that gets invoiced, not a liability drawn
    down against later invoices (decision 15). 2430 remains a retail layaway deposit and is
    unreached by any agency document.
  * **The vendor chain** — quote → approved purchase/expense → payable → settlement (decision 21).
    The accounts are seeded and the project dimension it needs now exists; the documents are
    procurement's.
  * **Gross vs. net pass-through.** The media recharge is still booked gross as revenue and 1270 is
    still unreached, so the *posting* remains to be built. What now exists is the decision it needs:
    `agency_proposal_lines.pass_through` records, line by line and at offer time, whether a figure is
    the agency's own revenue or the client's money moving past it — the only moment anybody actually
    knows the answer, and not something to infer at invoice time from how large a line is. Which way
    a given agency books it is still a business policy needing its own posting rule.
  * **Overdue balances per project.** `ar-service.ts` ages a *customer's* balance, and migration
    0260 added the partial index on `(business_id, due_date) WHERE status = 'approved'` that a
    per-project overdue list would read, but nothing surfaces it yet. Tax and discount are likewise
    the business's VAT setting and the invoice's own discount — there is no per-engagement tax
    profile.
* **§E Media** — client/project/campaign folder conventions, review state and short-lived scoped
  review links over the shared S3 media library.
* **§F Dashboard, AI and print** — the agency dashboard, its recommended widgets (AEC's came in
  migration 0202), AI drafting tools for briefs/proposals/copy/reports with approval gates, and the
  agency print templates (#1127).
* **Operating profiles** — the eight presets, their labels, their storage and their settings panel
  shipped in wave 2, and what a preset steers today is the blueprint ordering. Two of the three
  things the issue says a preset may control are still open, and both need a surface that does not
  exist yet rather than a field on `AgencyOperatingProfileDef`:
  * *default navigation* — the tenant rail is built from the industry's module set and the member's
    permissions (`tenant-navigation.ts`); there is no per-preset nav layer, and inventing one would
    be exactly the "hiding navigation and calling it a preset" the issue warns against.
  * *KPIs* — the agency dashboard and its widgets (§F) do not exist, so there is nothing for a
    preset to choose between. AEC's equivalent arrived with its own cockpit and migration 0202.
  * Combining specialties is stored (a primary plus secondaries) but only the primary is read today;
    the secondaries are labels for the picker and for later reporting, and are never a gate.
