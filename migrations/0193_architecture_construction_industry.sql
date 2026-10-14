-- Issue #799 — add the AEC industry to businesses.industry.
--
-- `architecture_construction` (مهندسی عمران، معماری و پیمانکاری) is one
-- business type covering architecture offices, civil/structural engineering
-- companies, contractors, design & build firms, consulting/supervision teams
-- and individual professionals. Which of those a business is stays an
-- *operating profile* it selects inside the industry (industry-profile.ts),
-- never a second key here — that is the whole point of the issue: no fifth
-- app, no parallel project system, one more entry in the registry.
--
-- The CHECK constraint was last widened in migration 0191 when `service_saas`
-- joined. It must be widened again or every provisioning path for the new
-- trade fails with a constraint violation. Additive and idempotent: the old
-- constraint is dropped by name and re-added wider, leaving every existing row
-- untouched. Re-running is safe on a schema where a later migration has
-- already widened or replaced it.
--
-- What this migration deliberately does NOT do:
--   * no new tables — AEC's project operations extend `ai_projects` and the
--     My Workspace tables from migration 0167 (see the issue's "extend, never
--     replace" rule); its BOQ/RFI/site-execution domains come in later waves;
--   * no backfill — no business can already be this industry, so there is
--     nothing to migrate;
--   * no feature-flag rows — the industry's restaurant-shaped defaults are
--     seeded per business at provision time from
--     `industryProfile().defaultDisabledFeatures` (business-provisioning.ts),
--     the same mechanism every other trade uses.
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
