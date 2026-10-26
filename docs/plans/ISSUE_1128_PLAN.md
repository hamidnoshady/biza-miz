# Issue #1128 — Advertising Agency business type (آژانس تبلیغاتی)

**Status of this change:** Wave 1 — the industry foundation. Registry, migration, chart of accounts
and profile, plus the posting/report wiring those four cannot be separated from, and the tests and
CI guard that hold them in place.

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
nouns and brand block, walked through the `service` setup shape, and refused — by module guard, by
family and by an empty line-kind list — everywhere the app would otherwise assume a counter or a
goods catalogue.

What it is **not** yet is the agency experience §A–§F of the issue describes. That is the point of
the split, and it is the same split #799 (AEC) and #839 (automotive) made: the trade exists and is
honest about what it has, and the workflows land on top of it in later waves rather than the other
way round. See «What this change does not build».

## What shipped

| Surface | Change |
|---|---|
| Registry | `advertising_agency` in `src/lib/industries.ts`, label «آژانس تبلیغاتی» (English *Advertising Agency*; «کانون تبلیغاتی» is recorded as the alternative copy, not as a second key), enabled in `ENABLED_INDUSTRIES` so `/welcome`, the platform picker and the provision dialog offer it |
| Family | `industryFamily("advertising_agency") === "service"`, so `hasSellableCatalogue` is false: product sync skips its site's "products" and a storefront order is refused as `industry_not_storefront` instead of being written as a retail sale |
| Database | `migrations/0259_advertising_agency_industry.sql` widens `businesses_industry_check` to twelve values — additive, idempotent, no new tables, no backfill, no feature-flag rows |
| Chart of accounts | `ADVERTISING_AGENCY_COA_TEMPLATE` (85 accounts: 21 asset, 20 liability, 7 equity, 13 revenue, 24 expense) — four service revenues, four direct client-cost accounts as cost of sales, a reimbursable client-cost receivable, unbilled project work, and a media/production payable |
| Profile | `INDUSTRY_PROFILES.advertising_agency` — brand «آژانس تبلیغاتی» / «مدیریت مشتری، پروژه، کمپین و امور مالی», `[...CORE_MODULES]` and nothing else, its own nouns (`AGENCY_LABELS`), `salesModel: retail_invoice`, restaurant-shaped flags seeded off, no capability |
| Setup wizard | `SETUP_SHAPE.advertising_agency = "service"` — business → accounts → tax → users → hardware → backup → opening; no `costing`/`menu` pair, no AEC-style profile step, no catalogue pointer on the finish page |
| Posting/report wiring | `accounting-posting-rules.ts` (inventory 1300, revenue 4640 with the other three named in the note, and where client media cost sits), `retail-stock-posting-rules.ts`, `retail-account-codes.ts`, `retail-invoice-service.ts` (no line kinds), `coa-template.ts`'s cost-of-sales list, and `account-classification.ts`'s 214x block |
| Operator warning | `industrySwitchCautions` now says out loud when a switch *removes the counter*: a catalogue trade turned into a service or project one keeps its stock rows and loses the ability to sell them |
| Tests | New blocks in `coa-template.test.ts`, `industry-profile.test.ts`, `wizard-steps.test.ts`, `accounting-posting-rules.test.ts`, `industries.test.ts`, `account-classification.test.ts`, `industry-coverage.test.ts`, and four real-database cases in `integration/business-industry.integration.test.ts` |

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
`permissions.ts` and the project role. This wave ships no preset machinery, because a preset with
nothing to switch on is a dropdown that lies; see «What this change does not build».

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

### 8 — POS-less, like AEC and `service_saas`

No `pos`, no `orders`, no `stock`, no trade catalogue, no line kinds in `retail-invoice-service.ts`,
no catalogue pointer on the wizard's finish page, and `salesModel: "retail_invoice"` because the
trade bills from the accounting suite rather than from a till. `industry-profile.test.ts`'s
`POS_LESS` list grows to three and pins it.

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

## Sites audited and deliberately left alone

The issue asks for every enumeration to be audited, so these are recorded rather than left to a
reader's guess:

* **`/api/industry/items/[id]/audit`** guards on `industry === "food_service"` and therefore admits
  the agency, AEC and `service_saas` — three trades with no `items` rows. It fails safe (the item
  lookup is branch-scoped, so a caller gets 404), and tightening it to `isRetailCatalogueIndustry`
  would change the status code two *shipped* trades return for a legacy-data audit. Left as is; a
  candidate for #1081's route-guard sweep rather than for this wave.
* **`src/lib/mcp/registry.ts`, `notification-authorization.ts`, `data-transfer/registry.ts`** branch
  on `architecture_construction` for AEC's own modules, tables and reminder keys. The agency has
  none of those in this wave, so there is nothing to add — and `mcpTenantEnabledModules` derives
  from the profile, so the agency's MCP surface follows its modules automatically.
* **Payment methods** (`payment-methods-service.ts`) branch on `food_service` only; the agency gets
  the same built-in ways every non-F&B trade gets, with SnapFood retired.
* **AI task presets** (`ai-tasks.ts`) restrict four presets to `food_service` and gate the rest by
  module and permission, which the new profile answers correctly with no edit.
* **Print templates** (`printing/template-catalog.ts`) derive eligibility from `hasModule`/
  `hasCapability`, so the agency is excluded from every POS, barcode, repair and serialized-retail
  template by construction. Agency documents (proposal, service quote, creative brief, statement of
  work, invoice, campaign report) are #1127's gallery, per the issue's own "integrate rather than
  duplicate".
* **`industry-coverage.test.ts`'s source scan** passes unchanged: the wave adds no hard-coded
  industry list anywhere in `src/`.

## Tests

Unit (`npx vitest run`, whole suite green — 1241 files / 15407 tests):

* `coa-template.test.ts` — the trade's eleven accounts, their side of the book and their parent
  heading; no hospitality account and no 1230; exactly one «پیش‌دریافت» liability; 1300 and 5600
  present with 5600 outside cost of sales; template returned by identity.
* `industry-profile.test.ts` — brand of its own, the forbidden module list, all four tenant apps
  reachable and no `workspace`/`projects` module key, agency nouns with no «منو»/«سفارش»/«کالا» in
  any of them, flags off, no capability, no `retailDefaults`, registration in the three registry
  surfaces, and `POS_LESS` grown to three.
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

Database (`npm run test:db`, needs `DATABASE_URL`):

* `integration/business-industry.integration.test.ts` — provisioning stores `advertising_agency`
  (the constraint migration is what makes that possible), seeds the agency chart and none of the
  café's, keeps the shared controls, turns `inventory`/`reservations`/`delivery` off, treats the
  console provision as a complete setup (no menu step), and switches a jewellery tenant into an
  agency **additively** — every pre-existing account keeps its id and name and the seeded list is
  exactly the difference.

## Rollout checklist

1. Merge; the migration is forward-only and applies in filename order (`0259_…` is last).
2. Fresh install: `npm run db:migrate`, then create an agency from `/welcome` — the picker offers
   «آژانس تبلیغاتی», the wizard walks seven steps, the accounts step proposes the agency chart.
3. Upgrade: `npm run db:migrate` on the production database. The constraint is dropped and re-added
   wider; no row is touched and no business is reinterpreted. Re-running is safe.
4. Console: provision an agency from `/platform/businesses` and open it — the sidebar brand reads
   «آژانس تبلیغاتی», the rail shows the four apps, and there is no till, no orders board, no menu
   and no products workspace.
5. Console: switch a *test* business from a retail trade to the agency and read the confirmation —
   it must name the lost counter, and the account list afterwards must be the union of the two
   charts.
6. Verify the refusal paths: a WooCommerce/CMS order ingest for an agency connection fails with
   `industry_not_storefront` rather than creating `items` rows, `/api/sales/*` is refused by the
   `pos` module guard, and behind that guard the trade's line-kind list is empty, so a retail
   invoice line cannot be written either.
7. Smoke one agency document end to end: a manual journal (or a service invoice) crediting 4640 and
   a purchase/expense debiting 5197, then read the gross-profit line in the income statement and
   confirm it moved by the client cost and not by 5600.

## What this change does not build

Deliberately, and each is named in the issue:

* **§A CRM** — agency pipeline stages, client briefs, multi-brand client accounts, proposals and
  scope-of-work documents, contract renewals. Canonical `parties`/leads/deals exist and the agency
  has the `crm` module; the agency-shaped pipeline and brief records do not.
* **§B My Workspace** — the seven project templates (brand identity, website/landing, social
  retainer, search/social campaign, outdoor/print campaign, video production, PR/event), the twelve
  agency stages, deliverable revisions and client approval states, resource scheduling. Projects,
  phases, tasks, documents and approvals all exist; the agency blueprints and their typed metadata
  do not. #1110's eligibility matrix must name this trade when it lands.
* **§C Growth** — campaign calendar and channel mix for *client* campaigns, the agency's-own vs
  client-managed split in reporting, spend/reach/CPL/CPA/ROAS with defensible attribution, manual
  import of platform data. No external ad-platform integration is claimed or implied anywhere in
  this change.
* **§D Accounting** — estimates/quotations, milestone and deposit billing, retainer subscriptions,
  change requests, the campaign/project P&L, and the vendor quote → purchase → payable → settlement
  chain. The accounts those documents will post to are seeded now; the documents are the next wave,
  and they must ride the existing posting/domain-event engine, never ad hoc journal entries.
* **§E Media** — client/project/campaign folder conventions, review state and short-lived scoped
  review links over the shared S3 media library.
* **§F Dashboard, AI and print** — the agency dashboard, its recommended widgets (AEC's came in
  migration 0202), AI drafting tools for briefs/proposals/copy/reports with approval gates, and the
  agency print templates (#1127).
* **Operating profiles** — the eight presets, their defaults and their settings panel (AEC's is
  `src/lib/aec.ts` + `/setup/aec-profile` + the settings form). Until presets have something to
  switch on, the wizard does not ask the question.
