# Phase 21 — Multi-Industry Accounting Platform Expansion (Jewelry, Watch & Accessories)

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 6 (inventory/costing), Phase 7 (double-entry ledger), Phase 12 (tenancy), Phase 15/17
(feature flags, plans), Phase 16 (accounting suite — AR/AP/manual-journal patterns this phase reuses)
**Tracks:** GitHub issue [#109](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/109)
**Goal:** Turn a single-industry (food & beverage) POS into a multi-industry accounting platform —
Core Accounting + Industry Modules — starting with gold/jewelry, watch, and accessories (bijoux),
without changing observable behavior for an existing F&B business.

---

## Why this is its own phase, not a slice of an existing one

Every phase so far has extended one business shape: a café/restaurant that sells menu items made
from recipes, seats guests at tables, and sends tickets to a kitchen. Nothing in the schema
discriminates *what kind* of business a tenant is — `businesses` has no type column at all. Gold,
watch, and accessories retail aren't new features of that shape; they're a different shape:
items that sell by weight and daily price instead of a fixed menu price, serialized units instead
of recipe-consumed ingredients, variant matrices instead of modifier groups. Reusing Core
Accounting (ledger, COA, fiscal periods, AR/AP, manual journals — all built and proven in Phases
7/16) while adding that different shape is the actual engineering problem this phase solves.

## Architecture principles (from the issue, made concrete)

- **Don't break existing POS/restaurant behavior.** Every existing integration/unit test keeps
  passing unmodified; F&B behavior is the regression baseline for the whole phase, not just a
  reminder.
- **Industry logic is separated from the accounting core** via a real **domain-event log + posting
  engine** (Wave 1) — replacing today's per-event posting functions (`postOrderPaymentEntry`,
  `postCogsEntry`, `postPurchaseEntry`, `postWasteEntry`, …, each hand-written in
  `ledger-service.ts`/`inventory-service.ts`). A new industry's posting rules become a
  registration against the engine, not a new copy of ledger code.
- **Capability-based.** `businesses.industry` is the new top-level discriminator; the existing
  `feature_flags`/`business_features`/`plans` system (Phase 15/17) becomes industry-aware rather
  than being replaced — see `src/lib/features.ts`'s `API_FEATURE_PREFIXES`/`PAGE_FEATURE_PREFIXES`,
  which this phase extends, not forks.
- **Domain events + posting engine**, one central mechanism, per above.
- **Full tenant isolation.** Every new table gets an RLS policy in the same migration that creates
  it, per the project-wide rule; `integration/tenant-isolation.integration.test.ts` covers new
  tables automatically once they exist.

## Scope decision: what "generalize" means here

Brainstormed and decided with the product owner before Wave 1 started: generalize the *posting*
core, not the item/inventory data model. This revises the phase's original brainstorm decision
(quoted below for the record) once building Wave 1 surfaced why unifying the item model isn't the
right call — see "Revised: `menu_items`/`inventory_items` are not migrated" just below.

Concretely:

- **The posting core generalizes** via the domain-event log + posting engine (see the architecture
  principle above) — proven end-to-end by wiring F&B's own waste posting through it. This is the
  part of "Core Accounting + Industry Modules" that actually needed to be shared, and it is.
- **Tables, floor plans, waiter app, kitchen display, and reservations stay F&B-specific**,
  already gated behind the `reservations` feature flag (Phase 17) — nothing in gold/watch/
  accessories retail has an equivalent concept, and generalizing them would be speculative,
  not something any of the three target industries need. They're simply not offered to a
  non-food-service business.
- The domain-event/posting-engine refactor (Wave 1) is where F&B's existing posting functions
  get re-expressed as registered rules against the new engine — same resulting journal entries,
  different internal plumbing. (In practice only one path, waste, has actually been re-expressed
  so far — see the Wave 1 progress notes below for why the rest are deliberately left alone.)

### Revised: `menu_items`/`inventory_items` are not migrated onto the generic item model

The phase's original brainstorm decision (recorded above the line for the historical record) called
for unifying `menu_items`/`inventory_items`/recipes onto the new generic Item/Variant/Serial
primitive, with F&B's behavior proven unchanged. Building Wave 1 far enough to actually attempt this
surfaced a fact the brainstorm didn't have: **`inventory_items` is not a thin catalog table** — it is
the anchor of five-plus phases (6, 12, 13, 15, 17, 19) of hardened, exact-arithmetic costing
machinery (FIFO lots, weighted-average, negative-layer shortage tracking, NRV write-downs, transfers,
cutover, purchase-receipt settlement), all built with `SELECT ... FOR UPDATE` row locking directly
against its own columns (`avg_cost`, `carrying_value_rial`, `purchase_unit_factor`, …) across roughly
seven `src/lib/*.ts` files. The new `items` table (migration 0050) deliberately carries none of that —
correctly so, since a jewelry piece's cost (weight × daily price/gram) has nothing in common with
FIFO lot consumption, and baking F&B-specific costing columns into a table meant to also serve
gold/watch/accessories would be exactly the kind of premature, wrong-shaped generalization the
project avoids elsewhere.

There is a genuinely favorable seam in the costing chain — `order_item_inventory_snapshots
.inventory_item_id` is the only handle any costing code needs downstream of order capture; nothing
downstream ever re-reads `menu_items`/`modifiers` — but that seam is about decoupling a sale from its
recipe at capture time, not about `inventory_items` itself being swappable. Actually migrating it
onto `items` would mean either bloating the generic model with F&B-only costing columns, or building
a second, parallel costing engine against a different table — duplicating ~7 already-hardened files'
worth of exact-arithmetic logic — for no industry that has shipped yet and needs to share it. That is
risk with no offsetting product value, the same lesson the posting-engine slice already taught at
smaller scale (see decision below).

**Decision (confirmed with the product owner, reversing the earlier call): `menu_items`,
`inventory_items`, and every table/service/route/UI surface built on them stay exactly as they are,
indefinitely — not deferred, not a future migration to revisit.** The generic `items`/
`item_variant_attributes`/`item_serials` primitive remains a parallel model, used only by the new
industries; each of those gets its own costing/stock machinery in its own wave (Wave 2's weighted
gold inventory, Wave 5's serialized watches), designed fresh for what that industry actually needs,
rather than either retrofitting F&B's engine onto them or theirs onto F&B's. A full map of every
place `menu_items`/`inventory_items` are touched (migrations, `src/lib/*.ts`, API routes, dashboard
UI, the sale→recipe→costing chain, `sku` usage, AI tools/reporting/exports) was produced while making
this call and confirms the two models can stay fully independent with no coupling left dangling.

## Waves

Same seven waves as the issue, resequenced so the genuinely shared primitive (item/variant/serial)
is built once in Wave 1 instead of separately in Waves 2, 5, and 6:

1. **Wave 1 — Multi-industry core.** `businesses.industry` (immutable after setup, like the
   costing-method lock); domain-event log (`domain_events`: `business_id`, `event_type`, `payload
   jsonb`, `source_type`/`source_id`) + posting-rule engine industry modules register against,
   proven by wiring F&B's own waste posting through it; generic Item/Variant/Serial primitive as a
   parallel model the new industries build on — **not** a migration target for `menu_items`/
   `inventory_items`/`recipes`, which stay exactly as they are (see the revised scope decision
   above); industry-aware setup wizard (Wizard step 1 picks the industry; each industry gets its
   own COA seed template and its own remaining wizard steps — the food-service path through the
   wizard is one instance of this, not special-cased code).
2. **Wave 2 — Weighted goods & gold inventory.** Fractional-weight quantities (grams, a new
   numeric-precision convention alongside integer-Rial money and the existing item primitive),
   purity/karat attributes, weight-based lots and stock counts, daily gold-price entry
   (per gram, per purity) — manual entry as the baseline, with an optional per-business external
   price-feed integration (configurable, not required).
3. **Wave 3 — Gold pricing engine & specialized sales.** The price formula (weight × purity-
   adjusted price/gram + اجرت [making charge, % or fixed] + profit % + VAT), a transparent
   receipt/POS breakdown of each component, and posting through Wave 1's engine.
4. **Wave 4 — Jewelry, stones & consignment.** Gem/stone attributes as cost add-ons on an item;
   consignment (امانی) as a subledger mirroring Phase 16's AR/AP pattern — held off the business's
   own balance sheet until sold, then a commission/settlement posting to the consignor.
5. **Wave 5 — Watch: serial, warranty, repairs.** Serialized units (one row per physical item,
   using Wave 1's serial primitive, not lot/weight averaging); warranty terms starting at sale;
   a repair/service ticket workflow (intake → parts consumed from inventory → labor cost → close).
6. **Wave 6 — Accessories & variant management.** Mostly UI and accessory-specific configuration
   on top of Wave 1's variant primitive — deliberately thin because the shared model already
   exists by this point.
7. **Wave 7 — Specialized reports & audit controls.** Weight reconciliation (physical scale count
   vs. system, in grams — the weight-based analogue of Phase 6's stock counts), consignment
   statements, warranty/repair reports, variant-level sales analysis, and an item-level audit trail
   for high-value serialized/weighed goods.

Each wave is still developed, tested, and PR'd independently, per the issue's own rule.

## Out of scope (for this phase)

- A business running more than one industry at once (v1: one `industry` per business, chosen once
  at setup, same lock pattern as inventory costing).
- Generalizing tables/floor/waiter/kitchen/reservations — not needed by any of the three target
  industries (see scope decision above).
- Iranian statutory e-invoicing/گارانتی-registry integrations for watches, or any real-time
  external gold-price provider selection — the *hook* for an external feed is in scope (Wave 2),
  picking and contracting a specific provider is not.
- A generic plugin SDK for third-party industry modules — three named industries, built in-repo,
  not an extensibility platform for arbitrary future ones (revisit if a fourth industry is ever
  requested).

## Exit criteria

- An existing F&B business shows zero behavioral change: every current integration/unit test
  passes unmodified, and a manual pass through setup → POS → kitchen → ledger looks identical.
- A new business can pick "gold/jewelry", "watch", or "accessories" at setup and get that
  industry's own item model, pricing/sales flow, and chart of accounts — with no F&B-only nav
  (menu, tables, waiter, kitchen, reservations) visible.
- A gold sale's receipt shows the full price breakdown (weight, purity-adjusted price/gram,
  making charge, profit %, VAT) and posts a balanced journal entry via the posting engine.
- A consignment item never appears in the business's own inventory valuation until sold, and
  selling it posts the correct commission/settlement split.
- A watch's serial number, warranty window, and repair history are all queryable from one item
  record, and a repair ticket's parts/labor post correctly to the ledger.
- Every new table has an RLS policy and is covered by the generated tenant-isolation test.

## Open questions

1. ~~**Generic item schema shape**~~ **Settled:** satellite tables per capability (`item_variant_attributes`,
   `item_serials`), matching how `menu_item_ingredients`/`modifier_ingredients` extend `menu_items`
   today — not a wide table with nullable industry-specific columns. Shipped in migration 0050.
2. ~~**Weight precision & rounding**~~ **Settled:** `numeric(24, 9)`, the same precision
   `inventory_lots.remaining_qty` already uses — no new convention. Rounding a computed price into
   integer-Rial reuses the existing `roundRial()`. Shipped in migration 0051.
3. **External gold-price feed** — provider TBD. The hook exists (`gold_prices.source`, shipped in
   migration 0052 and `gold-prices-service.ts`'s `source: 'external'`) and manual entry ships as the
   baseline; a specific integration is still a follow-up once a provider is chosen.
4. ~~**Consignment settlement accounts**~~ **Settled:** two new well-known codes, both distinct from
   Accounts Payable — `consignmentPayable` (2110) for what a sale owes the consignor and
   `consignmentCommissionRevenue` (4700) for the shop's own earning on it (Wave 4). Wave 7 added the
   settlement half: `consignment.payout` debits 2110 and credits cash/bank.
5. ~~**Repair ticket workflow detail**~~ **Settled (Wave 5):** its own five-state machine —
   `received → in_progress → ready → closed`, with `cancelled` reachable from any open state and both
   terminal states terminal — not a reuse of Phase 4's kitchen-ticket shape. A kitchen ticket lives for
   minutes and is never billed; a repair ticket lives for days, accrues parts and labor, and posts to
   the ledger when it closes. `closed` is deliberately unreachable through a bare status update
   (`validateRepairStatusTransition` rejects it), because closing is what posts.
6. **Can an existing F&B business ever switch industry later**, or is the setup-time choice as
   permanent as the costing-method lock? Leaning permanent for v1 (same reasoning as costing
   method — changing it retroactively would corrupt historical postings), revisit only if asked.

## Progress

Wave 1, first slice — implemented:

- **`businesses.industry`** (`migrations/0048_business_industry.sql`) — a `CHECK`-constrained text
  column (`food_service`/`jewelry`/`watch`/`accessories`), defaulted (and backfilled) to
  `food_service` for every existing business. Set once, at creation, in `provisionBusiness`
  (`src/lib/business-provisioning.ts`) — no update route exists, so it is immutable by omission
  rather than needing a separate lock flag the way inventory costing does. `src/lib/industries.ts`
  is the framework-free shared source of truth (the type, the full list, and which are actually
  offered) so both the server-side validator and the `/welcome` bootstrap UI import the same
  constants. Only `food_service` is in `ENABLED_INDUSTRIES` — the other three are selectable in the
  type system and rejected (`industry_not_available`) at the API if forced, and shown disabled with
  a "به‌زودی" badge in the UI, until their own wave lands a chart-of-accounts template and wizard
  steps. `resetBusiness` (`platform-service.ts`) was fixed to preserve `industry` across a
  platform-console reset — it re-inserts the business row from a pre-delete snapshot, and would
  otherwise have silently dropped a business back to the `food_service` default. Verified in
  `business-provisioning.test.ts` (default/accept/reject cases) and manually end-to-end (Playwright
  against a running dev server: submitted the `/welcome` form, confirmed the industry selector
  renders with only `food_service` enabled, and confirmed the created row's `industry` column).
- **Domain-event log + posting-rule engine** (`migrations/0049_domain_events.sql`,
  `src/lib/posting-engine.ts`) — `domain_events` records a business event generically
  (`event_type`, a jsonb `payload`, optional `source_type`/`source_id`); `registerPostingRule`
  lets a module teach the engine how to turn one event type into a balanced journal entry via the
  existing `postJournalEntry()`, and `emitDomainEvent`/`dispatchDomainEvent` record-then-post in
  the caller's own transaction, stamping `domain_events.entry_id` on success. An event with no
  registered rule, or a rule that returns `null`, is recorded but deliberately left unposted — not
  an error, since not every domain event has a ledger effect. Deliberately **not** wired to any of
  F&B's existing posting paths yet (`postOrderPaymentEntry` etc. are untouched) — that rewiring is
  its own follow-up slice, once this engine has shipped and proven out on its own. Verified in
  `integration/posting-engine.integration.test.ts` (posts and stamps `entry_id`, leaves an
  unregistered event type unposted, a rule returning `null` posts nothing, an unbalanced rule's
  lines are rejected exactly like every other posting path, and re-registering an event type
  replaces the previous rule).
- **Generic Item/Variant/Serial primitive** (`migrations/0050_generic_item_core.sql`,
  `src/lib/items.ts` + `src/lib/items-service.ts`) — a new, parallel `items` table
  (`kind`: simple/variant_parent/variant_child, `tracking`: none/serial/weight),
  `item_variant_attributes` (one row per distinguishing attribute on a variant child — Wave 6's
  accessories will build on this), and `item_serials` (one row per physical unit of a
  `tracking: 'serial'` item — Wave 5's watches). Weight/purity attributes are deliberately **not**
  part of this table set — that's Wave 2's job, once fractional-weight precision/rounding is
  actually decided rather than guessed at here. Not linked from `menu_items`/`inventory_items`/
  `recipes`, and per the revised scope decision above, never will be — this primitive is a parallel
  model for the new industries, not a migration target for F&B's own hardened costing engine.
  Verified in `integration/generic-items.integration.test.ts` (simple
  item creation, variant parent/child creation with attributes — including the all-or-nothing
  failure case leaving no orphan row — and serial registration/status lifecycle, including that a
  `sold` unit can never move to another status and a duplicate serial number is rejected) and
  `src/lib/items.test.ts` (the pure validation rules these lean on).
- All four new tables (`domain_events`, `items`, `item_variant_attributes`, `item_serials`) are
  automatically covered by `integration/tenant-isolation.integration.test.ts`'s generated
  policy-correctness check and `tenant-tables.ts`'s export/restore enumeration — both discover
  tables from `pg_class` rather than a hand-maintained list, so nothing needed updating there;
  re-ran both suites to confirm.

Wave 1, second slice — the posting engine's first real (non-test) wiring — implemented:

- **The engine now uses exact (RialText/BigInt) arithmetic, not plain-number `Rial`.** Auditing
  F&B's actual live posting surface (as opposed to the Phase 7 doc's original description) turned
  up that every inventory-costing-sensitive posting path — order payment, COGS, purchases, waste,
  stock counts, customer refunds — was already rebuilt at some point onto a private
  `postExactJournalEntry`/`RialText`/`Decimal`-based path (`ledger-service.ts`), superseding the
  original plain-`number` `postJournalEntry` for those cases specifically (non-costing postings —
  manual journals, AR/AP collection, payroll, expenses, closing entries — still correctly use the
  plain-number path, since they never multiply a fractional quantity by a unit cost). The engine
  as first shipped only knew about the plain-number path, which would have been the wrong
  foundation for Wave 2's weight × price/gram gold-pricing math. Fixed by exporting
  `postExactJournalEntry`/`ExactJournalLine` and switching `dispatchDomainEvent` to post through
  them; `PostingResult` also gained `postingKind`/`inventoryEventId`, the two report/reconciliation
  and inventory-traceability fields every existing exact posting path already carries and the
  engine had no way to pass through before.
- **`PostingRule` now receives the transaction's `PoolClient`, not just the event.** The original
  signature (`(event) => ...`) had no way for a rule to call `accountIdsByCode` — real posting
  logic needs to resolve account codes to ids inside the same transaction, so this was a real gap
  that only surfaced once a real rule was written against it, not a hypothetical one.
- **`src/lib/fnb-posting-rules.ts`** registers `inventory.operational_posting` — a generic
  Debit/Credit-one-amount rule mirroring `postExactOperationalInventoryEntry`'s own parametrised
  shape exactly. `src/app/api/inventory/waste/route.ts` (the only real caller of
  `postExactOperationalInventoryEntry`) now emits this event through the engine instead of calling
  that function directly. `postExactOperationalInventoryEntry` itself is completely unchanged and
  still directly covered by `integration/exact-operational-consumption.integration.test.ts` — nothing
  about its own behavior or callers-other-than-the-waste-route changed. The rest of F&B's posting
  functions (order payment, COGS, purchases, stock counts, AR/AP, payroll, expenses, manual
  journals, closing) are deliberately **not** migrated in this slice — they're proven and
  load-bearing, and there is no product need to move them onto this engine until a reason to
  (e.g. sharing logic with a new industry) actually shows up; forcing all of them through a new
  abstraction in one slice, with no new industry yet live to justify it, would have been risk
  without value.
- Verified in `integration/posting-engine.integration.test.ts` (extended: exact-arithmetic lines,
  a rule using the injected client to call `accountIdsByCode`, and `postingKind`/`inventoryEventId`
  stamping through to the posted entry) and a new
  `integration/fnb-posting-rules.integration.test.ts` (the registered rule reproduces the same
  balanced entry `postExactOperationalInventoryEntry` would for identical inputs — proving the two
  paths agree, not just asserting it). The full existing suite (899 unit tests, 273 integration
  tests including `exact-operational-consumption`) stayed green throughout. Manually verified
  end-to-end against a running server: seeded a business, gave an inventory item a real cost basis
  via a purchase, posted a waste entry through `/api/inventory/waste`, and confirmed — same API
  response shape as before, a `domain_events` row recorded and stamped `entry_id`, and the exact
  expected journal entry (Debit «ضایعات مواد» 5150 / Credit «موجودی مواد و کالا» 1300, correct
  amount, `posting_kind = 'waste'`).

Wave 1, third slice — the item-model scope decision — implemented:

- **`menu_items`/`inventory_items`/recipes will not be migrated onto the generic item model, ever
  — a deliberate decision, not a deferral.** See "Revised: `menu_items`/`inventory_items` are not
  migrated" above for the full reasoning (surfaced by a codebase-wide survey of exactly how deep
  F&B's costing engine is wired into `inventory_items`'s own columns). This closes out what was
  previously listed as "remaining Wave 1 work" on that front.

Remaining Wave 1 work at the time: the industry-specific setup-wizard branches (chart-of-accounts
template + remaining steps) for `jewelry`/`watch`/`accessories`, deferred until each of those waves
actually needed them — all four now exist (`coaTemplateForIndustry`, Waves 5/6) — there is nothing productive to build here before Wave 2+ defines what a gold/watch/
accessories business's own onboarding actually looks like. With the item-model question now settled,
Wave 1's core is otherwise complete.

Wave 2, first slice — weight/purity attributes and daily gold price entry — implemented:

- **Weight precision (open question 2) is settled: no new numeric convention.**
  `item_weight_attributes` (`migrations/0051_item_weight_attributes.sql`) uses `numeric(24, 9)`,
  the same precision `inventory_lots.remaining_qty` already uses (migrations 0012/0015) — deliberately
  generous headroom for a value that in practice never needs more than 3 decimal places, not a new
  decision to get wrong. Money produced by multiplying a weight by a price/gram (Wave 3's pricing
  engine) will round through the existing `roundRial()` (`src/lib/inventory-exact.ts`), the same
  rounding rule every other exact posting already uses.
- **`item_weight_attributes`** (one row per `tracking: 'weight'` item) carries `purity`,
  `gross_weight`, and `net_weight` (`net_weight` defaults to `gross_weight`; Wave 4's stone/gem
  attributes will deduct from it without a schema change). `src/lib/gold.ts` is the pure validation
  (mirroring the table's own CHECK constraints — positive weights, `net_weight <= gross_weight`,
  and a controlled `PURITIES` list: `18`/`21`/`24`). Coin ("سکه") purities are deliberately excluded
  — a coin prices per unit, not per gram, which doesn't fit this table or `gold_prices` below; that's
  a distinct pricing shape for a later wave, not guessed at here. `setWeightAttributes`/
  `getWeightAttributes` (`src/lib/items-service.ts`) validate the item is actually `tracking:
  'weight'` before writing, same pattern `addSerial` already uses for `tracking: 'serial'`.
- **`gold_prices`** (`migrations/0052_gold_prices.sql`) — one row per (business, purity, day),
  upserted rather than logged, since "today's price" is a single current fact. Business-wide, not
  per-location (a business follows one market price across branches, the same reasoning Phase 7 used
  for one consolidated ledger). `source` defaults to `'manual'` (the decided baseline) with an
  `'external'` value already modeled for the optional price-feed hook the brainstorm called for — no
  provider is wired up in this slice. `getGoldPrice`/`listCurrentGoldPrices`
  (`src/lib/gold-prices-service.ts`) read the latest price on or before a given date, so a business
  isn't forced to re-enter a price every single day.
- Both new tables are automatically covered by `integration/tenant-isolation.integration.test.ts`'s
  generated policy-correctness check (re-ran to confirm, 19 tests, no change needed).
- Verified in `src/lib/gold.test.ts` (the pure validation rules), extended
  `integration/generic-items.integration.test.ts` (setting/reading weight attributes, rejecting a
  non-weight-tracked item, upsert-replaces-not-duplicates, and the CHECK constraint itself rejecting
  `net_weight > gross_weight` even bypassing the service layer), and new
  `integration/gold-prices.integration.test.ts` (record/read, same-day replace not duplicate,
  independent purities, falling back to the most recent earlier price, per-business isolation, and
  the manual/external `source` distinction). `npx tsc --noEmit`, `npm test` (911 tests), `npm run
  test:db` (287 tests), and `npm run build` all pass.

Not yet built (later Wave 2 slices, or Wave 3): weight-based lots/FIFO consumption for bulk gold
stock, weight-based stock counts, and the setup-wizard's jewelry chart-of-accounts *branch* (the
template itself now exists — see Wave 3 below — but no wizard step offers `jewelry` as a selectable
industry yet, so nothing seeds it for a real business).

Wave 3, first slice — the gold pricing engine and a real (though not yet UI-wired) sale flow —
implemented. Two product decisions were confirmed with the product owner before writing any code,
since both carry real correctness/compliance stakes rather than being implementation details:

1. **VAT applies only to اجرت (making charge) + سود (profit), never the metal value.** Metal value
   is VAT-exempt under Iranian tax practice for gold jewelry — this is not a simplification, it's the
   actual rule, so `computeGoldSalePrice` (`src/lib/gold-pricing.ts`) computes VAT off
   `makingCharge + profit` only, and the two revenue accounts below exist specifically so the
   VAT-exempt and VAT-applicable portions of a sale are reportable separately, not commingled in one
   "gold sales" line.
2. **A gold piece's cost basis is a simple average cost per piece, recorded at intake
   (`unit_cost_per_gram`), not FIFO lots.** Bulk-gold FIFO tracking across many fungible pieces stays
   deferred (same open item as Wave 2's "not yet built" list above) until a business actually needs
   to pool raw material across pieces — this wave needed *a* real cost basis to post COGS, not the
   most general one.

What shipped:

- **Jewelry chart of accounts** (`src/lib/coa-template.ts`) — `JEWELRY_COA_TEMPLATE`, mirroring
  `FNB_COA_TEMPLATE`'s structure, reusing every generic account (cash, bank, AR, AP, VAT
  receivable/payable) and adding four new well-known codes: `goldInventory` (1320),
  `goldSalesRevenue` (4500, VAT-exempt metal value), `makingChargeRevenue` (4600, making charge +
  profit combined — VAT-applicable), `goldCogs` (5110). `WELL_KNOWN_CODES` is now a shared,
  multi-industry catalog rather than an implicitly-F&B-only one; `coa-template.test.ts` was updated
  to check each template against only the well-known codes its own industry actually uses, rather
  than asserting every template contains every code. Not yet seeded by any wizard branch — exists so
  the posting rules and their tests have real accounts to post against ahead of that UI work.
- **`item_weight_attributes` gained `unit_cost_per_gram` (nullable) and `status`**
  (`migrations/0053_item_weight_cost_status.sql`) — `status` (`in_stock`/`reserved`/`sold`) mirrors
  `item_serials.status` exactly, including `sold` being terminal
  (`validateWeightItemStatusTransition`, `src/lib/items.ts`); `setWeightItemStatus`
  (`items-service.ts`) mirrors `setSerialStatus`.
- **`src/lib/gold-pricing.ts`** — `computeGoldSalePrice`: metal value (net weight × price/gram,
  rounded), making charge (percent of metal value, or a flat amount), profit (percent of metal value
  + making charge), VAT (percent of making charge + profit only, per decision 1 above). Every
  component is rounded to whole Rial *as it's computed*, each stage built on the *previous stage's
  rounded value* — not one independent rounding of a final total — so a receipt's line items always
  sum to exactly the displayed total.
- **`src/lib/gold-posting-rules.ts`** registers two rules against Wave 1's engine — `gold.sale_revenue`
  (Debit Cash/Bank-Clearing/Accounts-Receivable by payment method; Credit `goldSalesRevenue` for
  metal value, `makingChargeRevenue` for making charge + profit, `vatPayable` for VAT) and
  `gold.sale_cogs` (Debit `goldCogs` / Credit `goldInventory` for net weight × `unit_cost_per_gram`)
  — mirroring Phase 7's "two entries per sale, not one" decision for F&B order payments (revenue
  recognition and cost of goods sold are conceptually distinct events).
- **`src/lib/gold-sales-service.ts`**'s `sellWeightedItem` orchestrates a full sale in the caller's
  transaction: validates the item is `tracking: 'weight'` and `status: 'in_stock'` with a cost basis
  set, looks up the day's price for its purity (Wave 2's `gold_prices`), computes the breakdown, posts
  both domain events, and flips the item to `sold` — all atomic, same discipline as every existing
  ledger posting path.
- Verified in `src/lib/gold-pricing.test.ts` (the formula itself: standard case hand-computed and
  checked line by line, VAT excluding metal value even when making charge/profit are zero, fixed vs.
  percent making charge, rounding, and every validation rejection) and
  `integration/gold-sales.integration.test.ts` (a full sale posting a balanced revenue entry and a
  balanced COGS entry with the exact expected amounts, the item flipping to `sold`, refusing to sell
  the same piece twice, refusing a sale with no cost basis set, and refusing a sale with no price
  entered for the item's purity). `npx tsc --noEmit`, `npm test` (926 tests), `npm run db:migrate`
  (twice) + `npm run test:db` (291 tests, `tenant-isolation`'s 19 tests re-confirming RLS), and
  `npm run build` all pass.

Not yet built (Wave 3 continued): no API route or POS/receipt UI calls `sellWeightedItem` yet
(service-layer only, same as how Wave 1 and Wave 2 each started); weight-based lots/stock-counts
remain deferred; and jewelry still isn't a selectable industry in `/welcome` (`ENABLED_INDUSTRIES`),
so none of this is reachable by an actual business yet — proven by integration test, not by a live
business, exactly like Wave 2's first slice.

Wave 4, first slice — gem/stone attributes as a cost add-on — implemented (consignment, Wave 4's
other half, deliberately not started this slice — its sale/commission mechanics need the same kind
of domain-specific confirmation VAT and cost-basis needed in Wave 3, not yet asked):

- **`item_stones`** (`migrations/0054_item_stones.sql`) — a child table (an item can carry several
  stones, e.g. a ring with a center diamond plus accent stones): `stone_type` (free text, unlike
  purity's controlled list — gem types vary far more than gold's fixed karat scale), `carat`, `cost`.
  Deliberately does **not** touch `item_weight_attributes.net_weight` — a stone's carat weight is not
  auto-converted to grams and subtracted from `gross_weight`; that conversion (irregular settings,
  mounting metal) would be a fragile approximation nobody asked for, so `net_weight` stays exactly
  what it's been since Wave 2: the business's own directly-entered gold-content figure. A stone's
  `cost` is what actually needs to flow into COGS.
- **`gold-posting-rules.ts`'s `gold.sale_cogs` rule now sums `item_stones.cost` alongside the metal
  cost** — read live from `item_stones` at posting time via the same client/transaction, not passed
  through the domain event's payload, the same "resolve against the current record, not a
  caller-supplied snapshot" instinct `accountIdsByCode` already uses for account ids.
- `src/lib/gold.ts` gained `validateStone`; `items-service.ts` gained `addStone`/`listStones`/
  `removeStone`/`totalStoneCost`, validating the item is `tracking: 'weight'` before allowing a
  stone, mirroring every other satellite-attribute function's own item-type guard.
- Verified in `src/lib/gold.test.ts` (stone validation) and extended
  `integration/generic-items.integration.test.ts` (add/list/remove, summing costs with zero-stones
  as the empty case, refusing a stone on a non-weight-tracked item, and confirming `net_weight` stays
  untouched) and `integration/gold-sales.integration.test.ts` (a real sale with a stone posts COGS as
  metal cost + stone cost, hand-verified). `npx tsc --noEmit`, `npm test` (930 tests), `npm run
  db:migrate` (twice) + `npm run test:db` (297 tests, `tenant-isolation`'s 19 tests re-confirming
  RLS), and `npm run build` all pass.

Wave 4, second slice — consignment (امانی) — implemented. Confirmed with the product owner before
writing any code: **a consigned piece is priced with the exact same formula as the shop's own
inventory** (`computeGoldSalePrice`, unchanged) — سود (profit) simply *means* the shop's commission
here instead of margin on owned stock, rather than consignment needing a different, negotiated-price
pricing model.

- **`consignors`** (`migrations/0055_consignment.sql`) mirrors `customers` (migration 0001) exactly
  — same shape, same Shape 1 RLS — and `src/lib/consignment-service.ts` mirrors
  `customers-service.ts`'s simplicity: no separate pure-validation module, matching how
  customers/suppliers are already validated inline in this codebase (that split is reserved for real
  computational logic like costing/pricing math, not "name is required").
- **`item_consignments`** (1:1 with an item, like `item_weight_attributes`) marks a `tracking:
  'weight'` item as held for a consignor rather than owned. No pre-agreed commission column — the
  sale-time making-charge/profit/VAT inputs (already how an owned sale works since Wave 3) are reused
  as-is; the commission rate is decided at the point of sale, not fixed at intake.
- **`gold-sales-service.ts`'s `sellWeightedItem` now branches on consignment status**: a consigned
  item skips the cost-basis requirement entirely (there's no "what the shop paid" for something it
  never bought) and posts through a new `gold.consignment_sale_revenue` rule instead of
  `gold.sale_revenue`/`gold.sale_cogs` — Debit the payment account for the total, same as an owned
  sale; Credit the new `consignmentPayable` liability for metal value + making charge (owed to the
  consignor, not the shop's revenue); Credit the new `consignmentCommissionRevenue` for profit (the
  shop's actual earning on the sale); Credit `vatPayable`, unchanged. **No COGS entry is posted at
  all for a consignment sale** — the shop never owned the piece, so there's nothing to relieve from
  an inventory asset it never held.
- Deliberately deferred (its own follow-up slice, mirroring how Phase 16 built AR/AP's invoice-then-
  collect/pay lifecycle in two stages): actually paying out the consignor their `consignmentPayable`
  balance. This slice creates the payable; settling it is separate, the same "invoice, then
  collect/pay" shape Phase 16's AR/AP subledgers already use.
- Verified in `integration/consignment.integration.test.ts` (consignor CRUD, marking an item
  consigned and refusing it on a non-weight-tracked item, a full consigned sale posting the correct
  three-way split with hand-verified amounts and *zero* `gold.sale_cogs` event, confirming the
  owned-inventory accounts are never touched by a consignment sale, and confirming an *unconsigned*
  item still requires its cost basis exactly as Wave 3 left it — a regression check, not just a new
  feature check). `npx tsc --noEmit`, `npm test` (930 tests — no new pure-unit coverage needed, per
  the customers/suppliers-style validation above), `npm run db:migrate` (twice) + `npm run test:db`
  (303 tests, `tenant-isolation`'s 19 tests re-confirming RLS on the two new tables), and `npm run
  build` all pass.

Not yet built: paying out a consignor's `consignmentPayable` balance (see above); consignment
statements/balances by consignor (Phase 16's AR/AP built these as their own slice too, off the same
"reconstruct from journal lines, never a shadow copy" discipline); and, as with every wave so far, no
API route or UI — service-layer only, proven by integration test.

Jewelry UI/routes slice — implemented. Everything Waves 2-4 built (weight/purity/cost basis, gold
prices, stones, consignors, consignment sales) was service-layer-only until now; this slice is the
first time a person can actually reach any of it — `/api/jewelry/*` route handlers and a
`/dashboard/jewelry` page, following the exact conventions `/api/inventory/*` and
`/accounting/inventory` already established (`requireRole`/`withTenantScope` guard on every handler,
`resolveActiveLocation` for the caller's branch, tabbed client manager + section components using the
shared `api()`/`Field`/`ErrorBox` helpers from `../ui`).

- **`src/lib/industry-guard.ts`** (new) — the industry-gating counterpart of `features.ts`'s
  `requireFeatureForPage`/`featureForApiPath` pair, keyed on the immutable `businesses.industry`
  (industries.ts) a session's business chose at creation rather than a togglable flag:
  `getBusinessIndustry`, `requireIndustryForPage` (redirects a gated dashboard page), and
  `requireIndustryForApi` (403s a gated route handler). Both the jewelry page and every `/api/jewelry/*`
  route call one of these — a non-jewelry business gets the same "not for you" treatment a disabled
  feature flag gets elsewhere.
- **`items-service.ts` gained `listWeightItems(locationId)`** — the jewelry item board's one round
  trip: every `tracking: 'weight'` item at a branch, joined with its weight/cost-basis attributes,
  its live stone-cost sum, and its consignment (if any) and the consignor's name. Everything else the
  routes needed already existed from Waves 2-4.
- **Routes**: `GET/POST /api/jewelry/items` (list the board / create a piece — creation validates the
  weight/purity input via `validateWeightAttributes` *before* inserting the `items` row, since the
  create-item-then-set-weight-attributes write isn't wrapped in a transaction and validating first is
  what keeps a bad request from leaving an orphaned item behind), `GET/PATCH /api/jewelry/items/[id]`
  (detail — item + weight attrs + stones + consignment in one response; PATCH edits the cost basis),
  `POST /api/jewelry/items/[id]/stones` + `DELETE .../stones/[stoneId]`, `POST
  /api/jewelry/items/[id]/consign` (wraps `markAsConsigned`), `POST /api/jewelry/items/[id]/sell`
  (wraps `sellWeightedItem` in the same `BEGIN`/`COMMIT`-around-a-`PoolClient` shape
  `/api/inventory/waste` uses, so a sale's postings and status change are atomic), and `GET/POST
  /api/jewelry/prices` + `GET/POST /api/jewelry/consignors`. Every handler is owner/manager only, same
  as `/api/inventory/*` — there's no established "who sells gold" role split yet, so the sell route
  isn't opened to cashier the way POS checkout is.
- **`/dashboard/jewelry`**: a tabbed manager (کالاها / نرخ طلا / امانت‌گذاران) mirroring
  `inventory-manager.tsx`'s structure exactly. The items tab's real complexity is per-row expandable
  panels (ویرایش بها / سنگ‌ها / امانی کردن / فروش) rather than a modal — cost-basis edits, stone
  add/remove, marking consigned, and selling all happen inline against the row they act on, and the
  sell/consign actions only render for an `in_stock` piece (a `sold` item just shows its final state).
- **Nav + gating**: `NavItem` (`dashboard-sidebar.tsx`) gained an `industry` field alongside the
  existing `flag` field; `dashboard/layout.tsx` now also fetches the business's `industry` in its
  existing `withTenant` `Promise.all` and passes it into `canSee`, so "طلا و جواهر" only ever appears
  in the sidebar for a jewelry business — the same "filtered out server-side before it reaches the
  client" property every flag-gated nav item already has. The page itself calls
  `requireIndustryForPage` the same way `/accounting/inventory` calls `requireFeatureForPage`.
- Manually verified end-to-end in a browser (Playwright against a seeded business flipped to
  `industry = 'jewelry'` with a jewelry chart of accounts inserted): recorded a gold price, created an
  owned piece with weight/purity/cost basis, added a stone, sold it, and independently created a
  second piece, marked it consigned to a new consignor, and sold it. Read back `journal_entries`/
  `journal_lines` afterward and hand-verified both postings balance and split correctly — the owned
  sale's COGS entry includes the stone's cost on top of metal cost, and the consignment sale posts
  its three-way split (`consignmentPayable`/`consignmentCommissionRevenue`/`vatPayable`) with **no**
  `gold.sale_cogs` event at all, confirming Wave 4's "the shop never owned it" design holds through
  the real UI, not just the integration tests.
- `npx tsc --noEmit`, `npm test` (938 tests — no new pure-unit coverage needed; every new file is
  either a route handler or a DB-touching service addition, per repo convention neither gets a direct
  unit test), `npm run db:migrate` (no new migration this slice — everything needed already existed)
  + `npm run test:db` (303 tests, `tenant-isolation`'s 19 tests re-confirming RLS unaffected), and
  `npm run build` all pass.

Not yet built (at that point): the jewelry industry still wasn't selectable in the setup wizard (Wave
1 deferred this — a business reached `industry = 'jewelry'` only via direct provisioning or an SQL
flip, not through `/welcome`'s UI); an external gold-price feed; paying out a consignor's
`consignmentPayable` balance and consignor statements; and weight-based lots/FIFO costing for bulk
gold stock.

Setup wizard slice — implemented. `jewelry` is now in `ENABLED_INDUSTRIES` (industries.ts), so
`/welcome`'s industry selector actually offers it — closing the gap the previous slice's "not yet
built" left. Getting a jewelry business all the way through the wizard needed the wizard itself to
stop assuming every business is F&B, which the seven waves before this one never had to confront
(every prior wave was reachable through `/dashboard`, never through `/setup`).

- **`src/lib/wizard-steps.ts`** (new) — `WIZARD_STEPS`/`OPTIONAL_STEPS`/`WizardStep` moved here from
  `setup-state.ts` (which now re-exports them, so its existing importers are untouched), because the
  new `wizardStepsForIndustry(industry)` needed to be callable from a client component
  (`src/app/setup/steps.ts`) without dragging `setup-state.ts`'s `next/server`/db imports into client
  code. `costing` (Phase 6's `inventory_items` FIFO/weighted-average choice) and `menu` (Phase 2's
  `menu_items`/`menu_categories`) are the two steps dropped for any non-`food_service` industry —
  neither table exists in a jewelry business's data model, per Wave 1's "never migrated" decision.
  Every other step (including all three optional ones) stays.
- **`src/app/setup/steps.ts`** gained `stepsFor(industry)` (resolves the filtered id list back to step
  metadata) and `skipToPath(id, steps)` (where to send a business that lands on a step its industry
  doesn't walk — a stale link, the back button — computed as "the first step after this one, in the
  full sequence, that *is* in the business's filtered list", not a hardcoded next-step guess).
  `nextPath`/`prevPath`/`stepIndex` all gained an optional `steps` parameter (defaulting to the full
  list, so every existing call site kept compiling) that the industry-aware call sites now pass.
- **`src/app/setup/industry-context.tsx`** (new) — a small React context resolved once, server-side,
  in `setup/layout.tsx` (`getBusinessIndustry`, the same helper the jewelry dashboard guard uses) and
  handed down via `SetupIndustryProvider`, so `StepNav`, `StepShell`, and every step page read the
  business's industry via `useSetupIndustry()` instead of each re-fetching it.
- **Guards on the two F&B-only step pages**: `/setup/costing` and `/setup/menu` now redirect a
  non-food_service business to `skipToPath(...)` on mount (covers a stale link or the back button —
  the normal forward flow's `nextPath` calls already skip straight past them). `/setup/opening` hides
  its "شمارش اولیهٔ انبار" (F&B inventory-count) subsection for non-food_service — that flow posts to
  `inventory_items`/`stock_movements` and requires the `costing` setting, which a jewelry business
  never sets; jewelry's own stock is entered through `/dashboard/jewelry`, not here. The ledger
  opening-balances subsection (industry-agnostic) stays for everyone.
- **`computeSetupState`** (`setup-state.ts`) now resolves the business's industry alongside its other
  fields and only requires `costing`/`items` (menu items) for completion when `wizardStepsForIndustry`
  actually includes those steps — a jewelry business finishes the wizard without ever touching either.
- **`business-provisioning.ts`'s `seedChartOfAccounts`** (used by Phase 15's console, which seeds a
  chart immediately at provisioning) and **`/api/setup/accounts`'s `GET`** (the manual wizard path,
  used by `/welcome`'s self-provisioned businesses) both now pick `JEWELRY_COA_TEMPLATE` vs.
  `FNB_COA_TEMPLATE` by the business's actual industry, instead of the seed path being silently
  F&B-only now that a jewelry business can reach it.
- A handful of step pages' copy is industry-aware where it would otherwise say something false for a
  jewelry business: `/setup/accounts`'s description names the actual industry instead of always
  saying "کافه و رستوران"; `/setup/tax`'s "you can set a per-category rate once you've entered your
  menu" hint only shows for `food_service` (a jewelry business has no menu categories, ever);
  `/setup/finish`'s summary line drops the menu-category/item counts for non-food_service.
- New unit tests: `src/lib/wizard-steps.test.ts` (food_service walks every step; jewelry skips exactly
  `costing`/`menu` and keeps everything else in the same relative order; every enabled or reserved
  industry gets a non-empty, in-order subsequence of `WIZARD_STEPS` that never drops an optional
  step). Extended `business-provisioning.test.ts`'s industry-validation tests: `jewelry` moved from
  the "rejected, not yet offered" list to the "accepted" list alongside `food_service`; `watch`/
  `accessories` stay rejected.
- Manually verified end-to-end in a browser (Playwright): bootstrapped a fresh jewelry business from
  `/welcome` all the way through `/setup/finish` — confirmed the sidebar shows exactly the six
  filtered steps (no قیمت‌گذاری/منو), the accounts step loads `JEWELRY_COA_TEMPLATE` (`موجودی طلا و
  جواهر` present, no F&B inventory account), `accounts`'s "next" lands on `tax` directly, the opening
  step hides its inventory-count subsection, the finish checklist/summary are industry-correct, and
  the wizard completes (missingForCompletion empty) without ever visiting costing or menu — then
  logged in as that business and confirmed `/dashboard/jewelry` is reachable with "طلا و جواهر" in the
  nav, composing correctly with the previous slice. Re-ran the same walkthrough for a `food_service`
  business afterward as a regression check: costing and menu still show in the nav, `accounts`'s
  "next" still lands on `costing`, and the F&B chart of accounts (`موجودی مواد و کالا`) still loads —
  confirming the industry filtering is additive, not a behavior change for the existing default path.
- `npx tsc --noEmit`, `npm test` (943 tests, up from 938), `npm run db:migrate` (no new migration this
  slice — everything needed already existed) + `npm run test:db` (303 tests, `tenant-isolation`'s 19
  tests re-confirming RLS unaffected), and `npm run build` all pass.

Not yet built: an external gold-price feed (Wave 2's optional `source: 'external'` hook exists but no
provider is wired up — blocked on the product owner picking one); paying out a consignor's
`consignmentPayable` balance and consignor statements (Wave 4's deferred follow-up); and weight-based
lots/FIFO costing for bulk gold stock (Wave 2's deferred costing subsystem — today's single
`unit_cost_per_gram` is an average-cost simplification, not FIFO lots).

Wave 5 — watch (ساعت): serialized units, warranty, repairs — implemented:

- **`item_serials` gained the lifecycle Wave 1 left to this wave**
  (`migrations/0067_watch_serials_warranty_repairs.sql`): `unit_cost` (nullable, same reasoning as
  `item_weight_attributes.unit_cost_per_gram` — a unit can exist mid-intake before its cost is known,
  and the sale path refuses to sell one with none), `warranty_months` (0 = sold with no warranty, a
  real answer rather than a missing one), and `sold_at`. A serialized unit is the easiest possible
  cost-basis case — one unit, one purchase, one cost — so unlike bulk gold there is no fungible-pool
  question deferred here at all.
- **`serial_warranties`** records the window that opens *at sale*, separate from the months column
  because the two answer different questions: the column is the term a unit *would* be sold with, the
  row is the window actually running on a unit that sold. `addMonthsToIsoDate` (`src/lib/watch.ts`)
  clamps to the target month's last day, so a 31st never spills into the next month — a warranty that
  silently gained a day is a customer-visible bug, not a rounding detail.
- **`repair_tickets` + `repair_ticket_parts` + `repair_ticket_counters`.** Ticket numbers are
  per-location and race-safe through the same atomic `UPDATE … RETURNING` counter Phase 2 uses for
  order numbers (migration 0003) — a repair ticket is a numbered document a customer walks out with.
  `serial_id` is nullable on purpose: most repairs walking into a watch shop are for a piece the shop
  never sold, so free-text `item_description` is the required identity and the serial link is the
  *optional* extra that makes the warranty check possible. A part carries `unit_cost` and `charge` as
  two separate columns rather than one marked-up number, because they post to different sides of the
  ledger — and because a warranty repair charges nothing while still consuming a part that cost real
  money.
- **`src/lib/watch.ts` / `watch-pricing.ts`** — the pure rules: cost/warranty validation, the month
  arithmetic above, the repair state machine (open question 5, settled above), and the sale and repair
  bills. A watch has a price, not a formula, and — unlike gold — none of it is VAT-exempt, so the only
  computation is VAT on the discounted price, rounded per component so a receipt's lines always sum to
  its total (Wave 3's rule, unchanged).
- **`src/lib/watch-posting-rules.ts`** registers four rules against Wave 1's engine:
  `watch.sale_revenue` (Debit payment account; Credit `watchSalesRevenue` + `vatPayable`),
  `watch.sale_cogs` (Debit `watchCogs` / Credit `watchInventory` for the unit's own cost),
  `watch.repair_revenue` (Debit payment account; Credit `repairServiceRevenue` + `vatPayable` — and
  **returns `null` on a zero total**, so a warranty job records its event and posts no revenue entry:
  exactly the "not every domain event has a ledger effect" path the engine was built with), and
  `watch.repair_cogs` (Debit `repairPartsExpense` / Credit `watchInventory`), which posts **even on a
  warranty job** — the shop ate the cost, and the books have to show it. Parts cost is summed live from
  `repair_ticket_parts` at posting time, not passed through the payload, matching what
  `gold.sale_cogs` already does with `item_stones`.
- **`watch-sales-service.ts` / `repairs-service.ts`** — the sale (revenue, COGS, status, warranty row,
  all atomic in the caller's transaction) and the intake → parts → labor → close workflow. Intake
  resolves the under-warranty question *once*, from the linked unit's live window, and stores it: the
  window can expire between intake and close, and what governs the bill is the state on the day the
  shop accepted the piece. A shop-owned unit goes to `in_repair` on intake and back to `in_stock` when
  the ticket closes or is cancelled; an already-`sold` unit stays sold (Wave 1's terminal-status rule
  is not walked back by a service visit).
- **Chart of accounts:** `WATCH_COA_TEMPLATE` plus five well-known codes (`watchInventory` 1330,
  `watchSalesRevenue` 4550, `watchCogs` 5120, `repairServiceRevenue` 4800, `repairPartsExpense` 5130),
  keeping unit sales and repair service as separate revenue lines — a shop wants to know what it earns
  servicing watches versus selling them. `coaTemplateForIndustry()` now centralizes the industry →
  template choice that three call sites were each ternary-ing; two industries could get away with
  that, four cannot.
- **`/api/watch/*` and `/dashboard/watch`** (دستگاه‌ها / تعمیرات), industry-gated exactly like the
  jewelry ones, and `watch` joined `ENABLED_INDUSTRIES` so `/welcome` offers it. The wizard needed no
  new work: `wizardStepsForIndustry` already drops `costing`/`menu` for any non-`food_service`
  industry.
- Verified in `src/lib/watch.test.ts` + `src/lib/watch-pricing.test.ts` (28 pure cases, including the
  short-month clamp and every rejection) and `integration/watch.integration.test.ts` (12 cases:
  hand-verified postings for a sale, a billed repair and a warranty repair, the warranty window,
  refusing to sell a unit twice or without a cost basis, per-location ticket numbering, and the
  `in_repair` ↔ `in_stock` shelf transitions). `npx tsc --noEmit`, `npm test` (1203), `npm run
  db:migrate` (twice) + `npm run test:db` (378), and `npm run build` all pass.

Wave 6 — accessories (بدلیجات) & variant management — implemented, and genuinely the thin wave the
plan predicted:

- Wave 1's variant primitive already models a product family and its variants
  (`items` with `variant_parent`/`variant_child`, `item_variant_attributes`, `createVariantChild`),
  so the only missing piece was the half a variant needs and the other two industries don't: an
  accessory is **fungible** — a countable quantity on hand and a shelf price, neither of which had
  anywhere to live. **`item_stock`** (`migrations/0068_item_stock.sql`) is that: `quantity`
  (`numeric(24,9)`, the precision this schema already spends on quantities), a running weighted-average
  `unit_cost`, and a `unit_price`. Deliberately **not** a second inventory subsystem — no lots, no
  movements, no FIFO — the same "prove the simple case first" call gold (one average cost per piece)
  and watch (one cost per unit) already made.
- **`src/lib/accessories.ts`** — the running average after a receipt and a sale line's price. This is
  deliberately not a call to `inventory-costing.ts`'s existing `calculateNewAverageCost`: that one is
  plain-number (`Rial`) arithmetic against F&B's costing engine, and every posting path this phase has
  built runs on the exact Decimal/RialText path instead (the correction Wave 1's second slice already
  made once). Recomputing a cost in floating point and then posting it exactly would put the
  imprecision back one layer up.
- **`accessories-posting-rules.ts`** registers `accessory.sale_revenue` / `accessory.sale_cogs` — the
  plain revenue/COGS pair, with no industry-specific split (nothing VAT-exempt like gold's metal value,
  no service line like watch's repairs).
- **`accessories-service.ts`** — receive stock (rolling the average forward under a `FOR UPDATE` read,
  since the new average depends on the row's current values), set a price, and sell. The sale posts
  both entries and decrements stock in one transaction, so stock can never drift from what the ledger
  was told; overselling is refused in front of the `CHECK (quantity >= 0)` that is the real guard.
  A `variant_parent` is rejected everywhere a sellable thing is expected — a product family is not a
  thing on a shelf.
- **`ACCESSORIES_COA_TEMPLATE`** plus three well-known codes (1340/4560/5140), `/api/accessories/*`,
  and a `/dashboard/accessories` page (families, variants with their attribute chips, stock/price,
  sale). `accessories` joined `ENABLED_INDUSTRIES`, so all four of Phase 21's industries are now
  offered at `/welcome`.
- Verified in `src/lib/accessories.test.ts` (11 pure cases) and
  `integration/accessories.integration.test.ts` (8 cases: average-cost roll-forward across receipts,
  hand-verified revenue/COGS postings, overselling refused with stock *and* the ledger untouched,
  price and cost kept as separate facts, and the board query). `npx tsc --noEmit`, `npm test` (1217),
  `npm run db:migrate` (twice) + `npm run test:db` (386), and `npm run build` all pass.

Wave 7 — specialized reports & audit controls — implemented, closing the phase:

- **Weight reconciliation (تطبیق وزنی)** — `weight_counts` (`migrations/0069_weight_counts.sql`) is
  the weight-based analogue of Phase 6's stock counts: one row per (branch, day, purity) recording
  what the scale said against what the books believed. `system_weight` is **stored at count time**,
  not recomputed on read — a count is evidence of a discrepancy on a given day, and a figure that
  drifted as later sales posted would be worthless as evidence (asserted directly in the integration
  test). It deliberately **posts nothing**: a gold variance in grams has no unambiguous Rial value
  under this phase's costing model, since each piece carries its own `unit_cost_per_gram`, so "0.4g
  missing" doesn't say whose cost basis to relieve. Valuing that variance needs the weight-based lot
  costing Wave 2 deferred; until then the count is an audit record and correcting the books is a
  manual journal (Phase 16's workflow) with this row as its evidence.
- **Consignor statements and payouts** — `getConsignorStatement` reconstructs what a consignor is owed
  from the domain-event log (metal value + making charge credited by each
  `gold.consignment_sale_revenue`, less each `consignment.payout`) rather than keeping a running
  balance column, the same "never a shadow copy" rule Phase 16's AR/AP statements follow; every line
  also carries the `entry_id` it posted, so statement and ledger reconcile against each other.
  `payConsignor` + the new `consignment.payout` rule (Debit `consignmentPayable`, Credit cash/bank)
  are the settlement half Wave 4 explicitly deferred — completing the "invoice, then collect/pay"
  shape. Overpaying is refused; `credit` as a payout method is refused (paying a consignor by taking
  on a receivable *from* them is not a thing).
- **Warranty and repair reports** — `warrantyReport` classifies every window ever opened at a branch as
  active/expiring/expired against a given date (`expiring` = active within a notice window, because a
  shop wants the list of customers whose cover is about to lapse, not just a yes/no). `repairReport`
  gives throughput by status and profitability — over **closed tickets only**, since an open ticket's
  agreed charges are an intention, not revenue — and reports a warranty job's negative margin rather
  than hiding it: the shop spent parts and billed nobody.
- **Variant-level sales analysis** — `variantSalesAnalysis` reads quantity, revenue and COGS straight
  off the `accessory.sale_*` events, so it can never disagree with the postings those same events
  produced.
- **Item-level audit trail** — the phase's last piece, and the one that justifies the domain-event log
  beyond posting. Sales and repairs already left a record; intake and edits did not, because they have
  no ledger effect — and they need none: the engine has recorded-but-unposted events as a designed
  path since Wave 1. `item-audit-service.ts`'s `recordItemEvent` appends `item.created`,
  `item.cost_basis_changed`, `item.stone_added`, `item.consigned`, `item.stock_received`,
  `item.price_changed` from the route handlers (the request is what knows *who* acted; the item
  services take neither actor nor business), best-effort so an audit note can never be why a
  legitimate edit fails. `itemAuditTrail` reads posted and unposted events back as one timeline,
  joined to the journal entry where there is one, and follows a watch unit by either its item id or
  its serial id.
- **Routes and UI**: `/api/jewelry/reports/*`, `/api/jewelry/consignors/[id]/payout`,
  `/api/watch/reports`, `/api/accessories/reports`, and `/api/industry/items/[id]/audit` (shared by all
  three industries — the timeline is the same log whoever wrote it, and the guard that matters is that
  the item belongs to the caller's branch; F&B is excluded because it has no `items` rows at all). Each
  dashboard gained a گزارش‌ها tab, and the jewelry/watch boards a per-item «تاریخچه» panel.
- Verified in `src/lib/industry-reports.test.ts` (12 pure cases) and
  `integration/industry-reports.integration.test.ts` (14 cases, every figure asserted against records
  the earlier waves' own services wrote rather than hand-inserted rows: the count's frozen system
  weight, a consignor statement's three-way split and its payout posting, overpay refusal, warranty
  classification across three windows, closed-only repair totals including the negative warranty
  margin, variant ranking, and an audit trail interleaving unposted lifecycle events with posted sale
  events — plus that another business's id returns nothing). `npx tsc --noEmit`, `npm test` (1235),
  `npm run db:migrate` (twice) + `npm run test:db` (400), and `npm run build` all pass.

### Where each exit criterion is satisfied

- *No behavioral change for an existing F&B business* — every pre-existing unit and integration test
  passes unmodified across all three waves (the only test edits were adding new cases and moving
  `watch`/`accessories` from the "rejected" list to the "accepted" list in
  `business-provisioning.test.ts`, which is the behavior change the waves were for).
- *A new business can pick any of the four industries at setup and get its own item model, sales flow
  and chart of accounts, with no F&B-only nav* — `ENABLED_INDUSTRIES` (all four),
  `coaTemplateForIndustry`, `wizardStepsForIndustry`, and the `industry` field on `NAV_ITEMS`.
- *A gold sale's receipt shows the full breakdown and posts a balanced entry* — Wave 3, unchanged.
- *A consigned item never appears in the business's own valuation until sold, and selling it posts the
  commission/settlement split* — Wave 4, with Wave 7 adding the statement and the payout that settles
  it.
- *A watch's serial number, warranty window and repair history are queryable from one item record, and
  a repair ticket's parts/labor post correctly* — `listSerialUnits`, `getSerialWarranty`,
  `listRepairsForSerial` (all three reachable from `GET /api/watch/units/[id]`), and Wave 5's four
  posting rules.
- *Every new table has an RLS policy and is covered by the generated tenant-isolation test* — the six
  tables added across Waves 5-7 (`serial_warranties`, `repair_ticket_counters`, `repair_tickets`,
  `repair_ticket_parts`, `item_stock`, `weight_counts`) each carry their policy in the same migration,
  and `integration/tenant-isolation.integration.test.ts` discovers them from `pg_class` — it passes
  with no edits, which is the point.

Deliberately still open after Phase 21 (each a product decision, not an unfinished build): an external
gold-price feed (the `source: 'external'` hook exists; no provider chosen); weight-based lot/FIFO
costing for bulk gold, and with it a *valued* weight variance that could post automatically; and coin
("سکه") pricing, which is per-unit rather than per-gram and so fits neither `gold_prices` nor
`item_weight_attributes`.
