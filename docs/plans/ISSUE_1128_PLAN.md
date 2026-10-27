# Issue #1128 — Advertising Agency business type (آژانس تبلیغاتی)

**Status of this change:** Waves 1 and 2.

*Wave 1* is the industry foundation: registry, migration, chart of accounts and profile, plus the
posting/report wiring those four cannot be separated from, and the tests and CI guard that hold them
in place.

*Wave 2* is the agency's own starting points: the eight operating profiles as one stored preset
(`src/lib/agency.ts`, the settings form, `PUT /api/settings/agency-profile`), the seven project
blueprints §B lists (`src/lib/workspace-agency-templates.ts`), and the sidebar contract test the P0
checklist asked for (`src/lib/tenant-navigation.test.ts`).

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

Unit (`npx vitest run`, whole suite green — 1243 files / 15435 tests after wave 2, 1241 / 15407
after wave 1):

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
  there is no till, orders board, menu, floor or warehouse, no shop word in the copy (one pinned
  exemption, above), and all four tenant apps are reachable. The same module assertion then runs for
  all twelve industries, so the next trade inherits it.
* `workspace-shared.test.ts` — the seven agency blueprints are offered to an agency and to nobody
  else, neither trade's set leaks into the other, the generic families survive, an agency preset
  orders its blueprints first without hiding the rest, and a preset from the other industry badges
  nothing.
* `audit.test.ts` — the new settings action is labeled in Persian, not shown as a dotted key.

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

## Rollout checklist

1. Merge; the migration is forward-only and applies in filename order (`0259_…` is last).
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
* **§D Accounting** — wave 2 gave the trade its ordinary sale document: a service invoice, on account
  or settled, one line per described service, each crediting one of the agency's four revenue
  accounts, posted by the existing `service.sale_revenue` rule. What is still missing is everything
  *around* that document: estimates/quotations, milestone and deposit billing, retainer
  subscriptions, change requests, the campaign/project P&L, and the vendor quote → purchase →
  payable → settlement chain. The accounts those documents will post to are seeded now; the
  documents are the next wave, and they must ride the existing posting/domain-event engine, never ad
  hoc journal entries. Nor does a service invoice settle the pass-through question the chart's 1270
  and 2430 exist for: the media recharge is booked gross as revenue today, and whether a given
  agency books it gross or net is a business policy that needs its own decision and its own
  document, not a flag on the invoice.
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
