-- ============================================================================
-- 0310_phone_first_signup_onboarding.sql — #1385 / #1387 / #1388.
--
-- The public journey this epic adds has three states that exist *before* any
-- business does, so they cannot live in a tenant table:
--
--   1. an SMS proof in flight for a number that has no identity yet
--      (`platform_signup_requests`),
--   2. a verified person filling in the short business onboarding
--      (`platform_onboarding_progress`),
--   3. the deployment-wide switch that decides whether the public door is open
--      (`platform_auth_settings`).
--
-- All three carry no `business_id` by construction. They are `platform_only`
-- under FORCE RLS — the same shape as `platform_mcp_connections` and the
-- managed-SMS credential tables — because a tenant connection has no business
-- reason to read another person's pending phone, name or business idea. The
-- platform scope reaches them through the documented `identity` / `platform`
-- bypass, exactly as `platform_email_verifications` already does.
--
-- Nothing here creates a business, membership, wallet, subscription or charge.
-- A signup request row is a proof in progress; an onboarding row is a person's
-- own draft; the setting is a boolean. Provisioning happens only in
-- `provisionFirstBusinessFromOnboarding`, inside one transaction keyed on the
-- identity, and #1383 forbids doing it in any migration.
--
-- Rollback: the three tables are additive and unused by any read path until the
-- services are called, so dropping them (plus the two constraint restorations
-- below) returns the schema to 0309. The `users_credentials` change is a
-- widening: the old constraint can be restored once no membership is phone-only.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Signup is a sixth purpose, not a reuse of `login`
-- ---------------------------------------------------------------------------
-- A code texted to prove a number at signup must never be spendable as a login
-- for an identity that already exists, and vice versa. The purpose vocabulary is
-- a CHECK constraint, so it has to grow here or the first real signup fails with
-- a constraint violation (`src/lib/auth-hardening.test.ts` pins the TypeScript
-- list; this keeps the database in step with it).
ALTER TABLE mfa_challenges DROP CONSTRAINT IF EXISTS mfa_challenges_purpose_check;
ALTER TABLE mfa_challenges
    ADD CONSTRAINT mfa_challenges_purpose_check CHECK (purpose IN (
        'login',
        'verify_login_phone',
        'change_login_phone',
        'mfa_login',
        'mfa_enrol_sms',
        'step_up_sms',
        'password_recovery',
        'contract_signing',
        -- #1385 — proving a mobile for a *new* personal identity. Distinct from
        -- `login` so a signup code cannot authenticate an existing account and a
        -- login code cannot create one.
        'signup'
    ));

-- ---------------------------------------------------------------------------
-- A signup attempt is its own limiter realm
-- ---------------------------------------------------------------------------
-- `requestSignupOtp` records the send in `auth_login_attempts` under this realm
-- so the same limiter covers signup. The realm vocabulary is a CHECK constraint
-- (0070, widened since by 0078/0215/0216/0250), so it has to grow here too or
-- the first successful signup send fails after the SMS has already gone out.
ALTER TABLE auth_login_attempts DROP CONSTRAINT auth_login_attempts_realm_check;
ALTER TABLE auth_login_attempts ADD CONSTRAINT auth_login_attempts_realm_check
  CHECK (realm IN ('tenant_password','platform_admin','directory','mfa_challenge','phone_otp','tenant_telegram','signup'));

-- ---------------------------------------------------------------------------
-- A membership may be phone-only (#1384's rule, at the tenant boundary)
-- ---------------------------------------------------------------------------
-- Nothing to change: migration 0187 dropped the legacy `users_credentials`
-- row-shape check on purpose, because credentials now live in
-- `employee_credentials` and a replicated membership may be inserted before a
-- credential exists. A phone-first owner therefore already needs neither a
-- password nor a PIN, and a placeholder hash (which #1384 forbids) is not
-- required. Do **not** reintroduce that CHECK here: it would reject the
-- credential-less memberships 0187 exists to allow.

-- ---------------------------------------------------------------------------
-- The signup proof in flight
-- ---------------------------------------------------------------------------
-- The names live here, not in the verify request body: the person typed them
-- once, and a second request that "confirms" them must not be able to swap the
-- identity's name between the SMS being sent and the code being redeemed.
CREATE TABLE platform_signup_requests (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164       text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    first_name       text NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 100),
    last_name        text NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 100),
    created_at       timestamptz NOT NULL DEFAULT now(),
    -- Set when the code is redeemed (or the request is superseded by a resend).
    consumed_at      timestamptz,
    -- The identity this request resolved to. An existing verified number links
    -- the person's *existing* identity here; it never creates a second one.
    platform_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL
);

-- The verify path reads the newest unconsumed request for the number.
CREATE INDEX idx_platform_signup_requests_live
    ON platform_signup_requests (phone_e164, created_at DESC)
 WHERE consumed_at IS NULL;

CREATE INDEX idx_platform_signup_requests_phone
    ON platform_signup_requests (phone_e164, created_at DESC);

COMMENT ON TABLE platform_signup_requests IS
    'One in-flight phone-first signup per number: the names typed once, the number being proven, and the identity it resolved to (#1385). Consumed, never deleted, so a support call can answer what happened.';
COMMENT ON COLUMN platform_signup_requests.platform_user_id IS
    'The identity the redeemed request resolved to. An already-verified number links the existing identity; no second identity is created.';

-- ---------------------------------------------------------------------------
-- Resumable short onboarding (#1387)
-- ---------------------------------------------------------------------------
-- One row per person, not per session: progress must survive a refresh, another
-- device and a new login. Business columns are stored here only until submit;
-- after provisioning the canonical rows (businesses/locations/settings) are the
-- source of truth and this table is the record of *how* they were captured.
CREATE TABLE platform_onboarding_progress (
    platform_user_id         uuid PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
    industry                 text,
    business_name            text,
    location_name            text,
    address                  text,
    phone_e164               text,
    -- Optional logo, held as the same data URL `settings.business.logo`
    -- stores (src/lib/business-logo.ts): validated on the way in, moved to the
    -- business's settings row in the provisioning transaction, never served
    -- from here.
    logo_data_url            text CHECK (
                                 logo_data_url IS NULL
                                 OR logo_data_url ~ '^data:image/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$'
                             ),
    logo_mime_type           text CHECK (
                                 logo_mime_type IS NULL
                                 OR logo_mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml')
                             ),
    logo_byte_length         integer CHECK (
                                 logo_byte_length IS NULL
                                 OR (logo_byte_length > 0 AND logo_byte_length <= 262144)
                             ),
    -- The last step the person reached, for the resume screen. Not a
    -- completion claim: only `provisioned_business_id` means done.
    step                     text NOT NULL DEFAULT 'industry' CHECK (
                                 step IN ('industry', 'business', 'logo', 'profile')),
    status                   text NOT NULL DEFAULT 'in_progress' CHECK (
                                 status IN ('in_progress', 'provisioned')),
    provisioned_business_id  uuid REFERENCES businesses(id) ON DELETE SET NULL,
    provisioned_at           timestamptz,
    submitted_at             timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CHECK (logo_data_url IS NULL OR (logo_mime_type IS NOT NULL AND logo_byte_length IS NOT NULL)),
    CHECK ((status = 'provisioned') = (provisioned_business_id IS NOT NULL))
);

CREATE INDEX idx_platform_onboarding_status
    ON platform_onboarding_progress (status, updated_at DESC);

COMMENT ON TABLE platform_onboarding_progress IS
    'Durable server-side progress of the short post-signup business onboarding (#1387). One row per person; provisioning is idempotent through provisioned_business_id.';
COMMENT ON COLUMN platform_onboarding_progress.provisioned_business_id IS
    'The business this onboarding created. Non-null is the only completion claim; a second submit returns this same business.';
COMMENT ON COLUMN platform_onboarding_progress.logo_data_url IS
    'Staged logo, same inline data-URL shape as settings.business.logo. Moved to the business setting during provisioning.';

-- ---------------------------------------------------------------------------
-- The public-registration switch (#1388)
-- ---------------------------------------------------------------------------
-- `configured` distinguishes "never set here" from an explicit `false`, so an
-- install that already runs on ALLOW_PUBLIC_SIGNUP=true keeps working until an
-- operator actually decides. Effective = configured ? enabled : the env value.
CREATE TABLE platform_auth_settings (
    id                    integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    public_signup_enabled boolean NOT NULL DEFAULT false,
    configured            boolean NOT NULL DEFAULT false,
    updated_by            uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    updated_at            timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_auth_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE platform_auth_settings IS
    'Deployment-wide authentication switches (#1388). Currently the public phone-first registration gate; authenticated SMS settings stay in platform_sms_config.';
COMMENT ON COLUMN platform_auth_settings.configured IS
    'False until a Superadmin saves the switch, so the pre-existing ALLOW_PUBLIC_SIGNUP environment decision is not silently overridden.';

-- ---------------------------------------------------------------------------
-- Platform-only isolation
-- ---------------------------------------------------------------------------
ALTER TABLE platform_signup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_signup_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON platform_signup_requests FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

ALTER TABLE platform_onboarding_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_onboarding_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON platform_onboarding_progress FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

ALTER TABLE platform_auth_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_auth_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON platform_auth_settings FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());
