# Clothing, Footwear & Fashion (`fashion_apparel`) — implementation checklist

Maps every requirement of GitHub epic [#1567](https://github.com/hamidnoshady/biza-miz/issues/1567)
to code locations, tests and completion status.
Linear mirror: [ESH-220](https://linear.app/eshobeai/issue/ESH-220).
Baseline: `b3bd5db` (main). Branch: `arena/caa8319d-biza-miz`. PR: #1575.

Status legend: **[x]** completed+verified · **[~]** partially implemented ·
**[ ]** not started · **[!]** blocked (reason inline).

---

## Phase 1 — Industry foundation (P0) — code complete, committed `dfac21b`, PR #1575

| # | Requirement (#1567) | Code locations | Tests | Status |
|---|---|---|---|---|
| 1.1 | `fashion_apparel` in `INDUSTRIES`/`ENABLED_INDUSTRIES`/labels | `src/lib/industries.ts` | `industry-coverage.test.ts` | [x] |
| 1.2 | Retail family + `hasSellableCatalogue=true` | `RETAIL_CATALOGUE_INDUSTRIES` in `src/lib/industries.ts` | `industry-coverage.test.ts` (family pins) | [x] |
| 1.3 | All exhaustive `Record<Industry,…>` maps | `industry-profile.ts`, `wizard-steps.ts`, `coa-template.ts`, `accounting-posting-rules.ts`, `retail-stock-posting-rules.ts`, `retail-invoice-service.ts`, `retail-account-codes.ts`, `workspace-eligibility.ts`, `onboarding-wizard.tsx`, `trade-goods.ts`, `trade-goods-posting-rules.ts` | tsc + per-file tests | [x] |
| 1.4 | Additive CHECK migration (no historical edits) | `migrations/0322_fashion_apparel_industry.sql` | `industry-coverage.test.ts` "database admits every industry"; fresh `db:migrate` (547 applied); constraint insert smoke test | [x] |
| 1.5 | Profile: core+pos+stock+fashion, `retail_invoice`, `barcode`, no F&B | `industry-profile.ts` (`MODULE_KEYS`, `INDUSTRY_PROFILES`) | `industry-profile.test.ts` | [x] |
| 1.6 | Retail wizard shape + catalogue href → `/accounting/products` | `wizard-steps.ts` `SETUP_SHAPE`, `catalogueHrefFor` | `wizard-steps.test.ts`, `ai-wizard-industry.test.ts` | [x] |
| 1.7 | Fashion COA (1374/4584/5184 + shared retail accounts) | `coa-template.ts` `FASHION_APPAREL_COA_TEMPLATE`, `WELL_KNOWN_CODES`, `COST_OF_SALES_CODES_BY_INDUSTRY` | `coa-template.test.ts`, `industry-coverage.test.ts` | [x] |
| 1.8 | Posting rules: inventory, revenue, COGS; parity of both maps | `accounting-posting-rules.ts`, `retail-stock-posting-rules.ts` | `accounting-posting-rules.test.ts` (pairing) | [x] |
| 1.9 | Line kinds: `stocked` POS lines | `retail-invoice-service.ts` `LINE_KINDS_BY_INDUSTRY` | full unit suite | [x] |
| 1.10 | Trade-goods registration (events, receipts, sells) | `trade-goods.ts`, `trade-goods-posting-rules.ts` memos | `trade-goods.test.ts` | [x] |
| 1.11 | Product workspace eligibility + `/api/fashion` adapter | `product-workspace.ts` | `product-workspace.test.ts`, `industry-coverage.test.ts` | [x] |
| 1.12 | Thin `/api/fashion` routes over shared `tradeGoods*` handlers | `src/app/api/fashion/**` (4 files) | route-tree/route-smoke + full suite; MCP coverage-map row | [x] |
| 1.13 | Apps/nav/billing/segment wiring | `apps.ts`, API prefix row, `billing/catalog/routes.ts` | billing `audit.test.ts`, coverage test | [x] |
| 1.14 | AI/MCP industry tools | `ai.ts`, `ai-capabilities.ts`, `ai-autopilot-executors.ts`, `mcp/registry.ts`, `mcp/tools.ts` (registry-driven) | `mcp/tools.test.ts`, `mcp/registry.test.ts` (docs regenerated) | [x] |
| 1.15 | Merchandising maps (sell-through/markdown) | `api/merchandising/*/route.ts` | full suite | [x] |
| 1.16 | Reports: `SALE_EVENT_PREFIX`, variant/low-stock/dead-stock via sets | `trade-reports-service.ts`, `reports.ts` (auto via `PRODUCT_WORKSPACE_INDUSTRIES`) | `reports.test.ts`, `platform-report-request.test.ts` | [x] |
| 1.17 | Workspace eligibility `false` | `workspace-eligibility.ts` | `workspace-eligibility.test.ts` | [x] |
| 1.18 | Onboarding business-name example + print sample | `onboarding-wizard.tsx`, `printing/template-samples.ts` | `template-samples.test.ts` | [x] |
| 1.19 | Provisioning validation (generic — no change needed) | `business-provisioning.ts` | `business-provisioning.test.ts` (fashion accepted) | [x] |

Verification evidence: scoped `tsc` 0 errors · eslint clean on changed files ·
full `vitest run` 20,076 passed / 0 failed · `db:migrate` 547 ok (0322 incl.) ·
constraint insert smoke test ok · integration `test:db` in progress.

## Phase 2 — Fashion products and variants (P0) — code complete, PR #1575

| # | Requirement | Code locations | Tests | Status |
|---|---|---|---|---|
| 2.1 | Parent style → independently sellable variants (own SKU/barcode/qty/prices/image/location/reorder) | existing `items`/`item_stock` via `product-creation-service.ts` | existing product tests | [x] generic model verified; fashion signup seeds Size/Color axes so variants are immediately sellable |
| 2.2 | Fashion attributes: sizes (intl shoe), colors, patterns, materials, fit, gender/age, season, collection, brand, care | `src/lib/product-attribute-templates.ts` (fashion catalog: Size + Color, `provisionByDefault`), `product-attributes-service.ts` `applyAttributeTemplate`, attributes section UI | `product-attribute-templates.test.ts`, `attributes-section.test.tsx` | [x] catalog preset seeded tenant-owned; extra attributes creatable via existing definitions UI |
| 2.3 | Configurable per-category attribute templates (tenant-aware, not global) | `POST /api/products/attributes/apply-template` (`{templateKey}` → `{ok,created,skipped}`; 400/404/409 contracts), provisioning auto-apply after `seedPaymentMethods` | `apply-template/route.test.ts` (5), `integration/fashion-attribute-templates.integration.test.ts` (4) | [x] skip-existing idempotent; foreign-industry 404; rename → template re-adds plain axis, never overwrites |
| 2.4 | Variable UOM for textiles (decimal) | item unit field is free text (no unit enum anywhere) | — | [x] verified no code needed — free-text units already cover kg/m/L/pcs/decimal |
| 2.5 | Size × color matrix, bulk create/edit, inline editing | client-side **Variant Matrix Builder** (`variant-matrix-draft.ts` + `variant-matrix-builder.tsx`, cap 100, duplicate-combo skip) feeding `ProductAddSection`; server matrix `/api/merchandising/matrix` auto-eligible; bulk prices = `price-lists-section.tsx` | `variant-matrix-draft.test.ts` (7), builder a11y tests | [x] generator generates parent + variants in one create; bulk matrix route has no frontend caller for **any** industry (API-only, by design) |
| 2.6 | Right-side sheet/offcanvas product editing (replace modals where appropriate) | dashboard products page is already section/sheet based (`product-add-section`, `attributes-section`) — no modal product forms exist in repo | product tests | [x] verified no code needed — requirement already satisfied for fashion |
| 2.7 | Barcode scan/print, images, keyboard shortcuts, RTL a11y | inherited generic barcode/label print + images + shortcuts; fashion print sample (`printing/template-samples.ts`); global RTL | `template-samples.test.ts`, design/eslint lint pass | [x] inherited; fashion sample added in Phase 1; no fashion-specific gaps found |
| 2.8 | No duplicate child combinations; creation ≠ stock posting | `duplicate_variant` invariant at `product-input.ts:703` (applies to fashion); matrix builder rejects duplicate combos client-side; creation posts nothing until sell/receive | `products.test.ts` (unit), `variant-matrix-draft.test.ts` | [x] verified for fashion — server invariant generic + client pre-check |

Phase-2 evidence: scoped `tsc` (14 files, `tsconfig.fashion-check.json`) exit 0 · eslint clean on all changed + new files · unit batch green (apply-template route 5 · templates/matrix/builder/section tests incl. 60-test batch: route 5 + ai-wizard-industry 9 + products-list-regressions 25 + business-provisioning 21 · industry-coverage 18) · integration `fashion-attribute-templates` 4/4 and `trade-goods` 8/8 (fashion invoice GL + COGS/revenue events).

## Phase 3 — Inventory, POS, returns (P0) — verified, PR #1575

| # | Requirement | Code locations | Tests | Status |
|---|---|---|---|---|
| 3.1 | Per-variant stock, multi-branch, receiving/opening/transfers/stocktake/valuation/damaged | canonical `retail-stock-service.ts` (purchase, transfer), `item-stock-count-service.ts`, `retail-warehouse-document-service.ts` (issue = damaged write-off); fashion resolves 1374 via `retail-stock-posting-rules.ts` | `integration/fashion-operations.integration.test.ts` 3.1 (purchase Dr1374/Cr2100, transfer Dr1360/Cr1374 then back, count shortage Cr1374 50,000, damaged issue Cr1374 50,000, GL 1374 = valued on-hand across both branches) | [x] verified on the shared engines. Pre-existing defect reported (not fixed): `item_stock.total_value_rial` goes stale after sales/transfers/returns, so a later warehouse issue over-relieves (see *Noticed*) |
| 3.2 | POS scan/search/size-color/mixed carts/discounts/tenders | `retail-invoice-screen.tsx` (`variantApiFor` + stocked line form), `retail-invoice-service.ts`, `item-barcodes-service.ts` | `fashion-operations` 3.2 (mixed cart of 2 styles/3 SKUs, line discount, split cash+bank tenders: total 708,500, 1100/1120/4584/2200/5184 exact; parent refused; oversell refused with stock untouched); `fashion-acceptance` (scan → exact SKU → sale) | [x] server flow verified; RTL/tablet UI walkthrough not automated here (visual-regression CI green) |
| 3.3 | Refunds, partial returns, size exchange M→L with price difference + GL | `customer-return-service.ts` (items-model branch), migration `0323_customer_return_retail_quantity.sql`, `order-read-service.ts` `returnable_quantity`, `customer-return-panel.tsx` | `fashion-returns` 7 ✓ (partial restock + proportional COGS reversal Dr1374/Cr5184, cap regression, damaged return, equal-price and **price-difference** M→L exchange — customer pays 21,800, net revenue 120,000, COGS 60,000 — partial refund 80,000 with prorated VAT 6,606, retry+race) | [x] `f59cfc6` + this commit. Exchange = linked return on the original invoice + new sale (no single exchange document; the return carries the original invoice link) |
| 3.4 | Concurrency/idempotency/offline/bad-barcode/tenant isolation | return advisory lock / `findDuplicateReturn`; invoice `clientRequestId` replay + `RetailRequestConflictError`; `item_stock` row lock on sale; `barcodeEntryError` / `BarcodeConflictError`; `item.locationId` guard; order lookup by `location_id` | `fashion-operations` 3.4 (bad EAN-13 check digit refused, duplicate code refused, unknown/other-branch code → no match; cross-branch sale refused; cross-tenant and cross-branch return → `completed_order_not_found`; offline replay = one order, conflicting payload refused; two tills racing for the last unit → one sale, stock 0) + `fashion-returns` retry/race | [x] verified for fashion |
| 3.5 | Category/style change never reassigns sold inventory/history | `order_items.name_snapshot` + `retail_snapshot` (qty, prices, discount, ledger ids) frozen at sale | `fashion-operations` 3.5 (rename + collection/season retag + reprice after sale: order lines and GL byte-identical; later return still recovers the original 50,000 and restocks the same SKU) | [x] invoices/ledger verified. Note: `sellThroughByCollection` attributes past sales by the item's *current* collection/season — a Phase-5 reporting gap (see *Noticed*) |

## Noticed — reported, not fixed (AGENTS.md rule 6)

- **Stale `item_stock.total_value_rial` (all retail trades, pre-existing on main).** Non-batch writers change `item_stock.quantity` without the carrying value: sales (`accessories-service`, `trade-goods-service`, `cosmetics-service`, `retail-online-sale-service`), `shipItemTransfer`, supplier returns, void/reversal restocks and the new customer-return restock (which mirrors the void pattern). The warehouse **issue** document values non-batch relief as `total_value_rial × qty / quantity`, so after any sale or transfer it over-relieves. Repro: receive 10 @ 50,000 → sell 4 → issue 1 damaged → relieved **83,333** (not 50,000); 5 on hand worth 250,000 but GL 1374 = 216,667. Needs one owner-approved fix across the item-stock writers.
- **Product-form opening quantity writes stock with no journal entry.** `createProductRecord` → `writeOpeningValues` → `receiveStock` puts quantity on `item_stock` without posting, so inventory exists off the books; conflicts with the epic's "product creation alone does not silently post stock". Shared across retail trades and UI-visible — needs a product decision (post an opening-balance entry, or route through a receipt).
- **Sell-through by collection uses current tags.** `merchandising-service.sellThroughByCollection` joins live `items.collection/season`, so re-tagging moves past sales between collections in that report (posted facts are untouched). Phase-5 item.
- **Trade sales reports ignore customer returns.** `variantSalesAnalysis` (variant_sales / brand_sales) and `sellThroughByCollection` read only `<trade>.sale_revenue` / `sale_cogs` events (+ online lines). Repro (fashion): sell 3 M @100,000 (cost 50,000), return 1 → report still says qty 3, revenue 300,000, COGS 150,000, margin 150,000; ledger says 200,000 / 100,000 / 100,000. Shared report SQL for every trade-goods trade.
- **Markdown write-down is measured at retail, not cost.** `merchandising-service.applyMarkdown` credits inventory `quantity × (oldPrice − newPrice)`. E.g. cost 50,000, price 100,000 → 70,000 on 5 units writes off 150,000 although NRV is still above cost (no write-down due); a deep cut can push the inventory account below the stock's cost. Shared accessories/cosmetics/fashion accounting — needs Hamid's review.
- **Connector payload:** `sanitizeProductPatch` bounds description length but does not refuse an inline `data:` (base64) URI inside it — the epic's lightweight-payload rule says media must travel as URLs.
- **Catalogue import is single-axis.** A size × colour grid cannot be imported as two typed attributes (see 4.3).
- Earlier: `trade-reports-service.ts` `SALE_EVENT_PREFIX.tools_fittings="tools"` vs emitted `tools_fittings.sale_revenue`.

## Phase 4 — Omnichannel (P1) — verified except 4.3 (single-axis import)

| # | Requirement | Code locations | Tests | Status |
|---|---|---|---|---|
| 4.1 | Woo/Eshobe parent-variant mapping for fashion | canonical `integrations/sync-service.ts` (family-driven via `isRetailCatalogueIndustry`), `integration_mappings`, `outbox-policy.effectivePushSwitches` (field ownership) | `integration/fashion-omnichannel.integration.test.ts` 4.1: a سایز × رنگ variable product → 1 non-sellable `variant_parent` + 6 sellable `variant_child` SKUs, each with BOTH typed attributes, unique combinations, parent link; re-sync updates in place (no duplicate/orphan rows); price ownership explicit — store price applies only on a store-owned connection | [x] verified |
| 4.2 | Lightweight connector payload rule | `woo-ops-service.sanitizeProductPatch` whitelist (`PRODUCT_UPDATE_FIELDS`), description bounds (`product-content.ts` 1,000 / 20,000), outbox merge per remote id; images travel as WordPress media URLs, never in outbox rows | `fashion-omnichannel` 4.2: `images` (base64), `meta_data` blob and `type` dropped; over-long description refused; two edits → one merged row `{regular_price, stock_quantity, __parentRemoteId}` < 200 bytes | [x] verified for fashion. Gap reported (see *Noticed*): an inline `data:` URI inside a ≤20,000-char description is not refused |
| 4.3 | Import templates (size×color grid) via #1235/Data Transfer | reviewed catalogue import `data-transfer/catalogue-{profile,plan,service}.ts`, `/api/data/catalogue` (fashion eligible via `isProductWorkspaceIndustry`) | — | [~] fashion can import styles + variants on **one** axis per run (`parent_sku` / `parent_title` / `option` + run `axis`). A two-axis size×colour grid lands as one combined attribute («M / مشکی»), not typed سایز + رنگ. Extending the shared importer (second option column, plan/service/route/UI) is a cross-trade change → follow-up for decision |
| 4.4 | Online order import/returns/conflict/idempotency | canonical `webhook-ingest-service.ts` (inbox unique delivery id + order mapping + advisory locks), `ingestRetailRefund`, cancellation stock-only path, `RETAIL_ACCOUNT_CODES.fashion_apparel` | `fashion-omnichannel` 4.4: order for M/مشکی relieves exactly that SKU (siblings untouched), posts 4584 −1,800,000 / 5184 800,000 / 1374 −800,000; same delivery retried + order re-sent → 1 order, 1 COGS entry; partial refund (restock) → +1 on the same SKU and COGS reversed 400,000, re-delivered refund ignored; cancellation restores 3 units once; ledger balanced | [x] verified |

## Phase 5 — Retail intelligence (P1) — verified, with reported report/markdown gaps

| # | Requirement | Code locations | Tests | Status |
|---|---|---|---|---|
| 5.1 | Collections/seasons/clearance/category-variant discounts | `item-brands-service.updateItemProfile` (collection/season), `merchandising-service` (`sellThroughByCollection`, `listMarkdownCandidates`, `applyMarkdown`), `/api/merchandising/*` (fashion wired in Phase 1), POS line discounts | `integration/fashion-intelligence.integration.test.ts` 5.1: sell-through grouped by collection/season off `fashion_apparel.sale_revenue`, branch-scoped; slow XL listed as markdown candidate (parent never), markdown posts Dr 5170 / Cr 1374 balanced | [x] verified, with two reported gaps: markdown write-down amount uses retail price, not cost (shared, accounting review); sell-through/variant reports ignore returns and use current tags |
| 5.2 | Replenishment/aging/sell-through by size-color, margins on posted COGS | `industry-reports-service.variantSalesAnalysis`, `retail-stock-service` `lowStockReport` / `deadStockReport` via `trade-reports-service` (`SALE_EVENT_PREFIX.fashion_apparel`) | `fashion-intelligence` 5.2: per size/colour qty, net revenue after discount, COGS and margin; report COGS == ledger 5184; dead stock (90-day rule) values never-sold S at cost 250,000; low stock lists sold-out M; parent never appears | [x] verified for sales; returns not netted (see *Noticed*) |
| 5.3 | CRM/loyalty/messaging reuse | core modules (in profile) | — | [x] inherited |
| 5.4 | Branch performance/profitability reports | same trade reports, branch-scoped by `location_id` | `fashion-intelligence` 5.4: main and branch each see only their own sales/stock (variant sales, dead/low stock, sell-through) | [x] verified |

## Phase 6 — Specialized operations (P2) — not started; needs design decisions

| # | Requirement | Status |
|---|---|---|
| 6.1 | Tailoring: measurements (privacy), fittings, custom orders, job progress | [ ] not started — new domain (personal measurement data needs a privacy/retention design). Nearest reusable engines: `repairs-service` (job lifecycle), CRM parties. Needs product design + its own issue |
| 6.2 | Garment production: materials, BOM, cut/sew stages, WIP, costing | [ ] not started — reuse candidate `production-service` (formulas, runs, reversal, exact costing; ledger posts are `always_approve` in MCP). Cut/sew stages and WIP accounts are not modelled there yet → design decision |
| 6.3 | Wholesale size packs, consignment, subcontractors | [ ] not started — `consignment-service` today covers `tracking: 'weight'` (gold) items only; size packs (pre-packs as a parent → child ratio) have no engine. Needs design |
| 6.4 | Advisory AI merchandising only (no autonomous postings) | [~] fashion AI lanes have **no** `autopilotCategory` (never run by an unattended tick); markdown/sell-through are read/advisory routes; MCP `fashion_apparel.item.sell` is `risk: low, approval: mode` — identical to the other trade-goods sells, so on an `apply`-mode MCP connection a sale posts without the approval queue. Whether fashion should step up to `always_approve` is Hamid's call (AI rules = high-risk area) |

## Phase 7 — Final verification

| # | Requirement | Status |
|---|---|---|
| 7.1 | Full test/typecheck/lint/build/CI green | [x] CI on `06a5fcd`: unit, type check, ESLint, production build, all 6 integration shards, visual regression, design checks, E2E — green |
| 7.2 | Migration upgrade + fresh provision smoke | [x] every integration file runs all migrations (0322, 0323) on a fresh DB; `fashion-acceptance` provisions a new fashion tenant via `provisionBusiness` (full COA + attribute seed) |
| 7.3 | 100-style / 2-branch / exchange / refund acceptance scenario | [x] `integration/fashion-acceptance.integration.test.ts`: 100 styles × 9 SKUs through the real product-creation path (900 unique SKUs + EAN-13, no parent codes, no orphans, duplicate combo + barcode collision refused with rollback, creation posts nothing), posted purchase, branch transfer, scanned sale + offline replay, M→L exchange with price difference, repeat+race, partial refund, damaged return → per-SKU stock and GL 1374 = on-hand value, ledger balanced |
| 7.4 | Regression: accessories, haberdashery, other retail, F&B | [x] CI integration shards green (all suites incl. accessories, haberdashery/trade-goods, cosmetics, retail invoice/void, F&B returns) |
| 7.5 | Evidence-based report on #1567 + ESH-220 | [ ] |
