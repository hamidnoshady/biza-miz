-- ============================================================================
-- 0316_short_business_onboarding.sql — ESH-202 / #1387.
--
-- The short post-signup business onboarding (#1387) starts after #1385 has
-- created a verified personal identity and before any business, branch,
-- membership, wallet or subscription exists. There is therefore no tenant to
-- scope its progress to: the owner has a global identity and nothing else.
--
-- `platform_onboarding_drafts` is that progress. It is keyed by the platform
-- identity, holds only the values the short flow is allowed to collect, and is
-- `platform_only` under FORCE RLS so no tenant connection can read another
-- person's draft. The business itself still comes from the canonical
-- provisioning service (`insertBusiness` in src/lib/business-provisioning.ts);
-- this table never creates a tenant by itself.
--
-- The draft's primary key is also the concurrency boundary: one row per person
-- and `provisioned_business_id` recorded in the same transaction as the
-- provisioning means a retry or a second tab reads the winner and returns it
-- rather than creating a duplicate business.
--
-- This migration also adds the two audit actions the optional profile step
-- needs. They follow #1384's existing `platform_identity_events` contract: ids
-- and action names only, never an email address or national ID.
--
-- Rollback: drop `platform_onboarding_drafts` and restore the 0303 action CHECK.
-- The service fails closed if the table is missing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform_onboarding_drafts (
    -- One draft per global person. The identity is the only key: no business id
    -- is accepted from the request, and the row cannot exist without a verified
    -- person.
    platform_user_id         uuid PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,

    -- Step 1 — one of ENABLED_INDUSTRIES. Validated in the service against the
    -- canonical registry before every write and again before provisioning; this
    -- column deliberately does not keep a second hardcoded list.
    industry                 text,

    -- Step 2 — the minimum supported business/location/contact data. Every one
    -- of these has a real column in `businesses`/`locations`; nothing invented.
    business_name            text,
    location_name            text,
    address                  text,
    phone                    text,

    -- Step 3 — the canonical `BusinessLogo` record (data URL + mime + size +
    -- timestamp) before a business exists. It is written into
    -- `settings.business.logo` through `SETTING_KEYS.businessLogo` in the same
    -- transaction that creates the business, so there is only one logo storage.
    logo                     jsonb,

    -- Step completion is explicit, so a skipped logo/profile is distinguishable
    -- from a step never reached. Values do not block completion on their own.
    completed_steps          text[] NOT NULL DEFAULT '{}',

    -- Confirmation + provisioning result. `submitted_at` is set only after the
    -- person confirmed the review; the two ids let a retry return the same
    -- business/membership instead of provisioning another.
    submitted_at             timestamptz,
    -- The draft's result goes with the business it created: leaving a submitted
    -- draft whose business was deleted would violate the shape check below.
    provisioned_business_id  uuid REFERENCES businesses(id) ON DELETE CASCADE,
    provisioned_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,

    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT platform_onboarding_drafts_industry_shape
        CHECK (industry IS NULL OR length(btrim(industry)) BETWEEN 1 AND 64),
    CONSTRAINT platform_onboarding_drafts_business_name_shape
        CHECK (business_name IS NULL OR length(btrim(business_name)) BETWEEN 1 AND 200),
    CONSTRAINT platform_onboarding_drafts_location_name_shape
        CHECK (location_name IS NULL OR length(btrim(location_name)) BETWEEN 1 AND 200),
    CONSTRAINT platform_onboarding_drafts_address_shape
        CHECK (address IS NULL OR length(address) <= 500),
    CONSTRAINT platform_onboarding_drafts_phone_shape
        CHECK (phone IS NULL OR length(phone) <= 32),
    CONSTRAINT platform_onboarding_drafts_logo_shape
        CHECK (logo IS NULL OR jsonb_typeof(logo) = 'object'),
    -- A draft cannot be marked provisioned without naming the business; a
    -- retry must have a result to return, never a "submitted but empty" row.
    CONSTRAINT platform_onboarding_drafts_provisioned_shape
        CHECK (
            submitted_at IS NULL
            OR provisioned_business_id IS NOT NULL
        )
);

COMMENT ON TABLE platform_onboarding_drafts IS
    'Server-side progress for the short post-signup business onboarding (#1387). One row per verified platform identity; platform-only under FORCE RLS. The canonical provisioning service remains the only writer of businesses/memberships.';
COMMENT ON COLUMN platform_onboarding_drafts.logo IS
    'Canonical BusinessLogo record held before the business exists; copied to settings.business.logo in the provisioning transaction.';
COMMENT ON COLUMN platform_onboarding_drafts.completed_steps IS
    'Explicit steps the person finished or intentionally skipped: industry, basics, logo, profile. Does not include setup-wizard completion.';
COMMENT ON COLUMN platform_onboarding_drafts.provisioned_business_id IS
    'Set in the same transaction as canonical provisioning; a retry returns this business instead of creating another.';

-- Platform-only isolation, the same shape as the other pre-tenant platform
-- tables (platform_signup_requests, platform_email_verifications).
ALTER TABLE platform_onboarding_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_onboarding_drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON platform_onboarding_drafts;
CREATE POLICY platform_only ON platform_onboarding_drafts FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

-- ---------------------------------------------------------------------------
-- Identity audit: email changes join the same append-only ledger
-- ---------------------------------------------------------------------------
-- #1384 audited national-ID writes/reads and email proof issue/consume. The
-- optional profile step can also set or clear the address itself, which is a
-- sensitive identity change and must be visible to the subject.
-- Extend the list without dropping the repair actions 0306 / 0307 added: an
-- install that already recorded a cleared phone or national-ID pair still
-- holds those rows, and the new predicate must accept them.
ALTER TABLE platform_identity_events
    DROP CONSTRAINT IF EXISTS platform_identity_events_action_check;
ALTER TABLE platform_identity_events
    ADD CONSTRAINT platform_identity_events_action_check CHECK (action IN (
        'national_id_set',
        'national_id_cleared',
        'national_id_read',
        'email_verification_issued',
        'email_verified',
        'phone_backfill_cleared',
        'national_id_pair_cleared',
        'email_changed',
        'email_cleared'
    ));
