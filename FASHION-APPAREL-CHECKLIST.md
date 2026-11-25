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

## Phase 3 — Inventory, POS, returns (P0)

| # | Requirement | Code locations | Tests | Status |
|---|---|---|---|---|
| 3.1 | Per-variant stock, multi-branch, receiving/opening/transfers/stocktake/valuation/damaged | canonical `retail-stock-service.ts`, warehouse docs | `retail-stock.test.ts`, integration | [~] shared engine; fashion inherits via 1.10 |
| 3.2 | POS scan/search/size-color/mixed carts/discounts/tenders | `retail-invoice-screen.tsx` (`variantApiFor` + stocked line form) | POS tests | [~] wiring done in Phase 1; scenario verification pending |
| 3.3 | Refunds, partial returns, size exchange M→L with price difference + GL | `customer-return-service.ts` (items-model branch), migration `0323_customer_return_retail_quantity.sql`, `order-read-service.ts` `returnable_quantity`, `customer-return-panel.tsx` (`retail-return-*` is the supplier contract, not this flow) | `integration/fashion-returns.integration.test.ts` (5 ✓: partial restock + proportional COGS reversal Dr1374/Cr5184, cap regression sold 3, damaged/discarded return, M→L exchange, retry+race) | [~] code complete in `f59cfc6`; exchange test uses equal M/L prices — a differing-price exchange (difference settled via the refund amount + new sale) is not yet asserted |
| 3.4 | Concurrency/idempotency/offline/bad-barcode/tenant isolation | existing engine + return advisory lock / `findDuplicateReturn` | `fashion-returns` retry + concurrent-race test (one return, one restock, one posting each) | [~] returns idempotency/race verified (`f59cfc6`); offline, bad-barcode and tenant isolation still to run for fashion |
| 3.5 | Category/style change never reassigns sold inventory/history | invariant in items model | — | [ ] verify |

## Phase 4 — Omnichannel (P1)

| # | Requirement | Code locations | Tests | Status |
|---|---|---|---|---|
| 4.1 | Woo/Eshobe parent-variant mapping for fashion | `retail-account-codes.ts` entry (done) + sync services (family-driven) | sync tests | [~] accounts wired; scenario tests pending |
| 4.2 | Lightweight connector payload rule | existing outbox design (family-driven) | `printing/connector-payload.test.ts` exists | [ ] audit |
| 4.3 | Import templates (size×color grid) via #1235/Data Transfer | data catalogue (auto via product-workspace set) | data tests | [~] eligibility auto; fashion template pending |
| 4.4 | Online order import/returns/conflict/idempotency | existing ingest engines | — | [ ] verify |

## Phase 5 — Retail intelligence (P1)

| # | Requirement | Code locations | Tests | Status |
|---|---|---|---|---|
| 5.1 | Collections/seasons/clearance/category-variant discounts | merchandising + promotions (shared) | — | [ ] |
| 5.2 | Replenishment/aging/sell-through by size-color, margins on posted COGS | `retail-stock-service`, `merchandising-service`, `trade-reports-service` | — | [~] maps wired; fashion runs via 1.10 |
| 5.3 | CRM/loyalty/messaging reuse | core modules (in profile) | — | [x] inherited |
| 5.4 | Branch performance/profitability reports | shared reports (auto) | `reports.test.ts` | [~] |

## Phase 6 — Specialized operations (P2)

| # | Requirement | Status |
|---|---|---|
| 6.1 | Tailoring: measurements (privacy), fittings, custom orders, job progress | [ ] |
| 6.2 | Garment production: materials, BOM, cut/sew stages, WIP, costing | [ ] |
| 6.3 | Wholesale size packs, consignment, subcontractors | [ ] |
| 6.4 | Advisory AI merchandising only (no autonomous postings) | [ ] |

## Phase 7 — Final verification

| # | Requirement | Status |
|---|---|---|
| 7.1 | Full test/typecheck/lint/build/CI green | [~] unit+lint+scoped tsc green locally; full tsc/build via CI; integration running |
| 7.2 | Migration upgrade + fresh provision smoke | [~] fresh `db:migrate` + constraint smoke done; new-tenant provision E2E pending |
| 7.3 | 100-style / 2-branch / exchange / refund acceptance scenario | [ ] |
| 7.4 | Regression: accessories, haberdashery, other retail, F&B | [~] full unit suite green; integration in progress |
| 7.5 | Evidence-based report on #1567 + ESH-220 | [ ] |
