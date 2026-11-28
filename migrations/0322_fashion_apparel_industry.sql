-- Issue #1567 — add the fashion_apparel industry to businesses.industry.
--
-- `fashion_apparel` (پوشاک، کیف، کفش و مد / Clothing, Footwear & Fashion) is
-- one business type covering the whole trade: men's/women's/children's
-- clothing, footwear, bags and leather goods, fashion accessories,
-- fabrics and textiles, uniforms, wholesale fashion and mixed fashion
-- retail. Which of those a shop actually stocks is an *operating profile*
-- inside the industry — the same reasoning migration 0193 recorded for AEC's
-- profiles and migration 0259 for the agency's eight — so a boutique that
-- also sells shoes is one tenant with two presets, never two rows here.
--
-- The CHECK constraint was last widened in migration 0259 when
-- `advertising_agency` joined. It must be widened again or every provisioning
-- path for the new trade fails with a constraint violation. Additive and
-- idempotent: the old constraint is dropped by name and re-added wider,
-- leaving every existing row untouched — no tenant's industry is changed and
-- no historical migration is edited. Re-running is safe on a schema where a
-- later migration has already widened or replaced it.
--
-- What this migration deliberately does NOT do:
--   * no new tables — fashion's catalogue, variants, stock, prices, barcodes
--     and media all live in the canonical `items` / `item_stock` /
--     product-attribute / barcode / media tables the other retail trades
--     already use (the issue's "no parallel fashion_products or fashion_stock"
--     rule), and its trade's own metadata, if a later wave needs any, lands in
--     its own migration the way 0194 followed 0193;
--   * no backfill — no business can already be this industry, so there is
--     nothing to migrate, and no existing tenant is reinterpreted;
--   * no feature-flag rows — the trade's restaurant-shaped defaults are seeded
--     per business at provision time from
--     `industryProfile("fashion_apparel").defaultDisabledFeatures`
--     (industry-profile.ts → business-provisioning.ts), the same mechanism
--     every other trade uses;
--   * no COA seeding — `seedChartOfAccounts` reads
--     `coaTemplateForIndustry("fashion_apparel")`, so the fashion chart (its
--     own merchandise-inventory / sales-revenue / COGS triple 1374/4584/5184
--     over the generic retail skeleton, with the shared returns, markdown,
--     write-down and count-variance accounts) arrives with the business the
--     moment this constraint admits it. Existing businesses keep their own
--     charts untouched; the seeding path is additive.
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_industry_check;
ALTER TABLE businesses
    ADD CONSTRAINT businesses_industry_check
    CHECK (industry IN (
        'food_service',
        'jewelry',
        'watch',
        'accessories',
        'cosmetics',
        'wholesale',
        'tools_fittings',
        'haberdashery',
        'service_saas',
        'architecture_construction',
        'automotive',
        'advertising_agency',
        'fashion_apparel'
    ));
