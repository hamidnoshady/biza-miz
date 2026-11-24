-- ============================================================================
-- 0319_signup_controls_and_funnel.sql — issue #1388.
--
-- Two additive pieces for the public signup / authentication-SMS console:
--
--   1. `platform_signup_settings` is the runtime control a Superadmin flips:
--      public registration on/off, and a maintenance pause with a Persian
--      message. It is a singleton with NO seeded row on purpose. An install
--      that has never opened the console keeps exactly its old behaviour: the
--      deployment gate (`ALLOW_PUBLIC_SIGNUP`) decides. The first console save
--      inserts the row, and from then on the runtime setting governs — which is
--      what makes "enable public registration" possible on an install whose
--      environment never set the variable. The service documents and tests this
--      precedence in `src/lib/iam/signup-controls.ts`.
--
--   2. `platform_signup_events` is the funnel ledger: stable event names and a
--      closed set of failure categories, with ids only. It deliberately has no
--      phone, email, name, code, token or provider payload columns, so an
--      aggregate read for the console cannot become a PII or OTP store.
--
-- Both are platform-only under FORCE RLS. Signup runs before any business
-- exists, so there is no tenant to scope these rows to.
--
-- Rollback: drop both tables. The service treats a missing settings table as
-- "not configured" (environment fallback) and simply stops recording events.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The runtime registration control
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_signup_settings (
    -- One row, ever. `updated_by` is attribution only; an admin delete must
    -- not remove the control, so it is SET NULL rather than CASCADE.
    id                    smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    public_signup_enabled boolean NOT NULL,
    maintenance_mode      boolean NOT NULL DEFAULT false,
    maintenance_message   text,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid REFERENCES platform_admins(id) ON DELETE SET NULL,

    -- A blank message is normalised to NULL by the service; a stored message
    -- must be usable copy a visitor can read.
    CONSTRAINT platform_signup_settings_message_shape
        CHECK (maintenance_message IS NULL OR length(btrim(maintenance_message)) BETWEEN 1 AND 500)
);

COMMENT ON TABLE platform_signup_settings IS
    'Runtime public-registration control (#1388). Singleton, no seeded row: absence means the ALLOW_PUBLIC_SIGNUP environment gate decides.';
COMMENT ON COLUMN platform_signup_settings.public_signup_enabled IS
    'The console switch. Only consulted while maintenance_mode is false; the environment gate is the fallback when no row exists.';
COMMENT ON COLUMN platform_signup_settings.maintenance_message IS
    'Optional Persian explanation shown to a visitor while maintenance_mode is on. Never contains provider or security detail.';

-- ---------------------------------------------------------------------------
-- The funnel ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_signup_events (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Stable names: renaming one breaks the console's aggregates, so the
    -- service exports this list as a typed constant and both sides share it.
    event            text NOT NULL CHECK (event IN (
                         'otp_requested',
                         'otp_sent',
                         'otp_failed',
                         'otp_verified',
                         'account_created',
                         'onboarding_started',
                         'onboarding_completed',
                         'business_provisioned'
                     )),
    -- Why an OTP attempt failed, from a closed vocabulary. NULL on success and
    -- on the lifecycle events.
    failure_category text CHECK (failure_category IS NULL OR failure_category IN (
                         'rate_limited',
                         'provider_failure',
                         'sms_not_configured',
                         'invalid_code',
                         'account_ambiguous',
                         'account_unavailable',
                         'unknown'
                     )),
    -- Ids only. A pending request has no identity yet, so both are nullable.
    platform_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
    business_id      uuid REFERENCES businesses(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),

    -- A failure category only belongs to an OTP outcome. Refusing it anywhere
    -- else keeps "failed sends / failed verifications" a truthful count.
    CONSTRAINT platform_signup_events_failure_shape
        CHECK (failure_category IS NULL OR event IN ('otp_failed', 'otp_verified'))
);

CREATE INDEX IF NOT EXISTS idx_platform_signup_events_event_created
    ON platform_signup_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_signup_events_created
    ON platform_signup_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_signup_events_failure
    ON platform_signup_events (failure_category, created_at DESC)
 WHERE failure_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_signup_events_identity
    ON platform_signup_events (platform_user_id, created_at DESC)
 WHERE platform_user_id IS NOT NULL;

COMMENT ON TABLE platform_signup_events IS
    'Privacy-preserving signup/onboarding funnel (#1388): stable event names, a closed failure vocabulary, and ids only — never a phone, email, name, OTP, token or provider payload.';
COMMENT ON COLUMN platform_signup_events.failure_category IS
    'Closed failure category for an OTP outcome; NULL on success. Values are operator-facing aggregates, not raw provider codes.';

-- ---------------------------------------------------------------------------
-- Platform-only isolation
-- ---------------------------------------------------------------------------
ALTER TABLE platform_signup_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_signup_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON platform_signup_settings;
CREATE POLICY platform_only ON platform_signup_settings FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

ALTER TABLE platform_signup_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_signup_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON platform_signup_events;
CREATE POLICY platform_only ON platform_signup_events FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());
