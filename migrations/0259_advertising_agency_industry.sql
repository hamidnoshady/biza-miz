-- Issue #1128 Wave 1 — add the advertising-agency industry to businesses.industry.
--
-- `advertising_agency` (آژانس تبلیغاتی; the alternative copy کانون تبلیغاتی is a
-- naming preference, not a second key) is one business type covering the whole
-- trade: full-service agencies, digital/social agencies, branding and creative
-- studios, media buying and performance shops, outdoor and print-production
-- agencies, content and video studios, PR and events companies, and the
-- one-person freelancer. Which of those a business is stays an *operating
-- profile* inside the industry — exactly the reasoning migration 0193 recorded
-- for AEC's eight profiles — so an agency that combines branding with media
-- buying is one tenant with two presets, never two rows here.
--
-- The CHECK constraint was last widened in migration 0211 when `automotive`
-- joined. It must be widened again or every provisioning path for the new trade
-- fails with a constraint violation. Additive and idempotent: the old constraint
-- is dropped by name and re-added wider, leaving every existing row untouched.
-- Re-running is safe on a schema where a later migration has already widened or
-- replaced it.
--
-- What this migration deliberately does NOT do:
--   * no new tables — the agency's client projects, briefs, deliverables,
--     approvals and campaign records extend `ai_projects`, the My Workspace
--     tables, CRM `parties`/deals and the Growth campaign domain (the issue's
--     "extend, never duplicate" rule); its own typed metadata, if a later wave
--     needs any, lands in its own migration the way 0194 followed 0193;
--   * no backfill — no business can already be this industry, so there is
--     nothing to migrate, and no existing tenant is reinterpreted;
--   * no feature-flag rows — the trade's restaurant-shaped defaults are seeded
--     per business at provision time from
--     `industryProfile("advertising_agency").defaultDisabledFeatures`
--     (industry-profile.ts → business-provisioning.ts), the same mechanism
--     every other trade uses;
--   * no COA seeding — `seedChartOfAccounts` reads
--     `coaTemplateForIndustry("advertising_agency")`, so the agency's chart
--     (its four service revenues, its media/production/subcontractor cost of
--     sales, its reimbursable-client-cost receivable and its media payable)
--     arrives with the business the moment this constraint admits it. Existing
--     businesses keep their own charts untouched; the seeding path is additive.
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
        'advertising_agency'
    ));
