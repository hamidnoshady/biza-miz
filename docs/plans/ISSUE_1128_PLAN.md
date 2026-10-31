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

* **§A CRM** — agency pipeline stages, client briefs, multi-brand client accounts, proposals and
  scope-of-work documents, contract renewals. Canonical `parties`/leads/deals exist and the agency
  has the `crm` module; the agency-shaped pipeline and brief records do not.
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
  this change.
* **§D Accounting** — wave 2 gave the trade its ordinary sale document (a service invoice, on account
  or settled, one line per described service, each crediting one of the agency's four revenue
  accounts, posted by the existing `service.sale_revenue` rule), and wave 3 gave it the documents
  that decide what to ask for: milestone, deposit, retainer and hourly billing schedules, change
  requests that revise an engagement's value, and the campaign/project P&L with its booked half kept
  apart from its posted half. Client receivables arrive through the invoice itself — an agency
  invoice defaults to on account (نسیه), so the posting engine raises the receivable and §D's
  collected/owed split is read from the invoices a project produced. What is still missing:
  * **Estimates and quotations.** A schedule is laid out against an engagement that exists; there is
    no pre-contract document to price work the client has not yet agreed to, and no path from a
    quotation to a signed engagement.
  * **True customer advances.** A `deposit` is a milestone that gets invoiced, not a liability drawn
    down against later invoices (decision 15). 2430 remains a retail layaway deposit and is
    unreached by any agency document.
  * **The vendor chain** — quote → approved purchase/expense → payable → settlement (decision 21).
    The accounts are seeded and the project dimension it needs now exists; the documents are
    procurement's.
  * **Gross vs. net pass-through.** The media recharge is booked gross as revenue and 1270 is
    unreached. Which way a given agency books it is a business policy needing its own document and
    posting rule, never a flag on an invoice and never inferred from how large a line is.
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
