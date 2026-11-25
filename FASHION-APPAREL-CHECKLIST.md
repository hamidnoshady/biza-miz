# Clothing, Footwear & Fashion (`fashion_apparel`) — implementation checklist

Maps every requirement of GitHub epic [#1567](https://github.com/hamidnoshady/biza-miz/issues/1567)
to code locations, tests and completion status.
Linear mirror: [ESH-220](https://linear.app/eshobeai/issue/ESH-220).
Baseline: `b3bd5db` (main). Branch: `arena/caa8319d-biza-miz`.

Status legend: **[x]** completed+verified · **[~]** partially implemented ·
**[ ]** not started · **[!]** blocked (reason inline).

---

## Phase 1 — Industry foundation (P0)

| # | Requirement (#1567) | Code locations | Tests | Status |
|---|---|---|---|---|
| 1.1 | `fashion_apparel` in `INDUSTRIES`/`ENABLED_INDUSTRIES`/labels | `src/lib/industries.ts` | `industry-coverage.test.ts` | [ ] |
| 1.2 | Retail family + `hasSellableCatalogue=true` | `RETAIL_CATALOGUE_INDUSTRIES` in `src/lib/industries.ts` | `industry-coverage.test.ts` (family pins) | [ ] |
| 1.3 | All exhaustive `Record<Industry,…>` maps | `industry-profile.ts`, `wizard-steps.ts`, `coa-template.ts`, `accounting-posting-rules.ts`, `retail-stock-posting-rules.ts`, `retail-invoice-service.ts`, `retail-account-codes.ts`, `workspace-eligibility.ts`, `onboarding-wizard.tsx`, `trade-goods.ts`, `trade-goods-posting-rules.ts` | tsc + per-file tests | [ ] |
| 1.4 | Additive CHECK migration (no historical edits) | `migrations/0322_fashion_apparel_industry.sql` | `industry-coverage.test.ts` "database admits every industry" | [ ] |
| 1.5 | Profile: core+pos+stock+fashion, `retail_invoice`, `barcode`, no F&B | `industry-profile.ts` (`MODULE_KEYS`, `INDUSTRY_PROFILES`) | `industry-profile.test.ts` | [ ] |
| 1.6 | Retail wizard shape + catalogue href → `/accounting/products` | `wizard-steps.ts` `SETUP_SHAPE`, `catalogueHrefFor` | `wizard-steps.test.ts`, `ai-wizard-industry.test.ts` | [ ] |
| 1.7 | Fashion COA (1374/4584/5184 + shared retail accounts) | `coa-template.ts` `FASHION_APPAREL_COA_TEMPLATE`, `WELL_KNOWN_CODES`, `COST_OF_SALES_CODES_BY_INDUSTRY` | `coa-template.test.ts`, `industry-coverage.test.ts` | [ ] |
| 1.8 | Posting rules: inventory, revenue, COGS; parity of both maps | `accounting-posting-rules.ts`, `retail-stock-posting-rules.ts` | `accounting-posting-rules.test.ts` (pairing) | [ ] |
| 1.9 | Line kinds: `stocked` POS lines | `retail-invoice-service.ts` `LINE_KINDS_BY_INDUSTRY` | covered by retail-invoice tests via trade-goods | [ ] |
| 1.10 | Trade-goods registration (events, receipts, sells) | `trade-goods.ts` (`TRADE_GOODS_INDUSTRIES`, `TRADE_GOODS_ACCOUNTS`), `trade-goods-posting-rules.ts` memos | `trade-goods.test.ts` | [ ] |
| 1.11 | Product workspace eligibility + `/api/fashion` adapter | `product-workspace.ts` | `product-workspace.test.ts`, `industry-coverage.test.ts` | [ ] |
| 1.12 | Thin `/api/fashion` routes over shared `tradeGoods*` handlers | `src/app/api/fashion/**` | route-tree/route-smoke tests | [ ] |
| 1.13 | Apps/nav/billing/segment wiring | `apps.ts`, `industry-profile.ts` API prefixes, `billing/catalog/routes.ts` | `industry-coverage.test.ts` (app rail), billing segment test | [ ] |
| 1.14 | AI/MCP industry tools | `ai.ts`, `ai-capabilities.ts`, `ai-autopilot-executors.ts`, `mcp/registry.ts` | `mcp/tools.test.ts`, ai tests | [ ] |
| 1.15 | Merchandising maps (sell-through/markdown) | `api/merchandising/*/route.ts` | — | [ ] |
| 1.16 | Reports: `SALE_EVENT_PREFIX`, variant/low-stock/dead-stock via sets | `trade-reports-service.ts`, `reports.ts` (auto via `PRODUCT_WORKSPACE_INDUSTRIES`) | `reports.test.ts`, `platform-report-request.test.ts` | [ ] |
| 1.17 | Workspace eligibility `false` (retail, not project-based) | `workspace-eligibility.ts` | `workspace-eligibility.test.ts` | [ ] |
| 1.18 | Onboarding business-name example | `onboarding-wizard.tsx` | — | [ ] |
| 1.19 | Provisioning validation (generic — no change expected) | `business-provisioning.ts` | `business-provisioning.test.ts` | [ ] |

## Phase 2 — Fashion products and variants (P0)

| # | Requirement | Code locations | Tests | Status |
|---|---|---|---|---|
| 2.1 | Parent style → independently sellable variants (own SKU/barcode/qty/prices/image/location/reorder) | existing `items`/`item_stock` model via `product-creation-service.ts` | existing product tests | [~] model exists; fashion presets pending |
| 2.2 | Fashion attributes: sizes (intl shoe), colors, patterns, materials, fit, gender/age, season, collection, brand, care | product attribute definitions (`product-attributes`), fashion templates | attribute tests | [ ] |
| 2.3 | Configurable per-category attribute templates (tenant-aware) | attribute definitions API `/api/products/attributes` | attribute tests | [ ] |
| 2.4 | Variable UOM for textiles (decimal) | item unit model (already numeric) | — | [ ] verify only |
| 2.5 | Size × color matrix, bulk create/edit, inline editing | `src/app/dashboard/products/*` matrix (merch matrix exists: `/api/merchandising/matrix`) | product tests | [ ] |
| 2.6 | Right-side sheet/offcanvas product editing (replace modals where appropriate) | product add/edit panels | product tests | [ ] |
| 2.7 | Barcode scan/print, images, keyboard shortcuts, RTL a11y | existing barcode templates + label print | design-lint | [ ] |
| 2.8 | No duplicate child combinations; creation ≠ stock posting | `product-creation-service.ts` invariant (existing) | existing | [~] verify for fashion |

## Phase 3 — Inventory, POS, returns (P0)

| # | Requirement | Code locations | Tests | Status |
|---|---|---|---|---|
| 3.1 | Per-variant stock, multi-branch, receiving/opening/transfers/stocktake/valuation/damaged | canonical `retail-stock-service.ts`, warehouse docs | `retail-stock.test.ts`, integration | [~] shared engine; fashion inherits once 1.10 done |
| 3.2 | POS scan/search/size-color/mixed carts/discounts/tenders | `retail-invoice-screen.tsx` (`variantApiFor` + `isTradeGoodsIndustry` line form) | POS tests | [~] needs fashion wiring (1.12) |
| 3.3 | Refunds, partial returns, size exchange M→L with price difference + GL | `retail-return-*`, `retail-order-reversal-service.ts` | `retail-return-validation.test.ts` | [ ] verify scenario |
| 3.4 | Concurrency/idempotency/offline/bad-barcode/tenant isolation | existing engine | integration tests | [ ] run for fashion |
| 3.5 | Category/style change never reassigns sold inventory/history | invariant in items model | — | [ ] verify |

## Phase 4 — Omnichannel (P1)

| # | Requirement | Code locations | Tests | Status |
|---|---|---|---|---|
| 4.1 | Woo/Eshobe parent-variant mapping for fashion | `retail-account-codes.ts` entry (1.9 done) + sync services (family-driven) | sync tests | [~] accounts wired; scenario tests pending |
| 4.2 | Lightweight connector payload rule | existing outbox design (family-driven) | — | [ ] audit |
| 4.3 | Import templates (size×color grid) via #1235/Data Transfer | data catalogue (`/api/data/catalogue` — auto via product-workspace set) | data tests | [~] eligibility auto; fashion template pending |
| 4.4 | Online order import/returns/conflict/idempotency | existing ingest engines | — | [ ] verify |

## Phase 5 — Retail intelligence (P1)

| # | Requirement | Code locations | Tests | Status |
|---|---|---|---|---|
| 5.1 | Collections/seasons/clearance/category-variant discounts | merchandising + promotions (shared) | — | [ ] |
| 5.2 | Replenishment/aging/sell-through by size-color, margins on posted COGS | `retail-stock-service`, `merchandising-service`, `trade-reports-service` (1.16) | — | [~] maps wired; fashion runs once 1.10 |
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
| 7.1 | Full test/typecheck/lint/build/CI green | [ ] |
| 7.2 | Migration upgrade + fresh provision smoke | [ ] |
| 7.3 | 100-style / 2-branch / exchange / refund acceptance scenario | [ ] |
| 7.4 | Regression: accessories, haberdashery, other retail, F&B | [ ] |
| 7.5 | Evidence-based report on #1567 + ESH-220 | [ ] |
