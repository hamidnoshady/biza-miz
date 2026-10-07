-- Issue #839 Wave 1 — add the automotive industry to businesses.industry.
--
-- `automotive` (خودرو و نمایشگاه اتومبیل) is one business type covering car
-- dealerships and vehicle traders, new and used alike: which of the two a
-- given *vehicle* is, is a property of that vehicle
-- (`automotive_vehicle_attributes.condition`), never a second industry key —
-- the same reasoning migration 0193 recorded for AEC's operating profiles.
--
-- The CHECK constraint was last widened in migration 0193 when
-- `architecture_construction` joined. It must be widened again or every
-- provisioning path for the new trade fails with a constraint violation.
-- Additive and idempotent: the old constraint is dropped by name and re-added
-- wider, leaving every existing row untouched. Re-running is safe on a schema
-- where a later migration has already widened or replaced it.
--
-- What this migration deliberately does NOT do:
--   * no new tables — the trade's vehicle identity/cost/hold schema is
--     `0212_automotive_vehicle_stock.sql`, kept separate so the registry change
--     (this file) can land and be verified on its own, exactly as 0193 and 0194
--     were split;
--   * no backfill — no business can already be this industry, so there is
--     nothing to migrate;
--   * no feature-flag rows — the trade's restaurant-shaped defaults are seeded
--     per business at provision time from `automotiveProfile.defaultDisabledFeatures`
--     (industry-profile.ts → business-provisioning.ts), the same mechanism
--     every other trade uses;
--   * no COA seeding — `seedChartOfAccounts` reads
--     `coaTemplateForIndustry("automotive")`, so the chart arrives with the
--     business the moment this constraint admits it.
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
        'automotive'
    ));
