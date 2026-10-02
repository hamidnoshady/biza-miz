-- 0193 — Phase 43 — Architecture/Civil/Construction business type (issue #799).
--
-- Extends businesses.industry, seeds the AEC chart-of-accounts codes that did
-- not already exist as shared rows, and adds AEC-specific fields to
-- My Workspace projects.
--
-- AEC operating profiles/capabilities are code-level presets (src/lib/aec.ts),
-- not a second industry discriminator — so no business_kind / profile column is
-- added here.

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
        'architecture_construction'
    ));

-- Workspace extension: AEC project metadata (kept additive and nullable so
-- non-AEC projects are unaffected). All columns are nullable/defaulted — no
-- backfill needed; seedChartOfAccounts handles new AEC businesses at provision
-- time (business-provisioning.ts) and changeBusinessIndustry is additive too.
ALTER TABLE ai_projects
    ADD COLUMN IF NOT EXISTS aec_operating_profile text
        CHECK (aec_operating_profile IN (
            'architecture_office','civil_engineering','contractor','design_build',
            'consulting_supervision','multidisciplinary','team','individual'
        )),
    ADD COLUMN IF NOT EXISTS aec_specialties text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS aec_contract_value numeric,
    ADD COLUMN IF NOT EXISTS aec_location_text text;
