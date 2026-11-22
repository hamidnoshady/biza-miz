-- ============================================================================
-- 0312_phone_first_signup.sql — ESH-200 / #1385.
--
-- A public person proves a mobile number by SMS *before* any personal identity
-- exists. The proof in flight cannot live in a tenant table: there is no
-- business to scope it to, and creating one as a side effect of registration is
-- exactly what the epic forbids. It gets its own platform-only table.
--
-- This migration does three additive things:
--
--   1. `signup` becomes a sixth OTP purpose. A code texted to prove a number at
--      signup must never be spendable as a login, a phone change, an MFA factor,
--      a recovery code or a contract signature, and none of those may create a
--      person.
--   2. `signup` becomes its own login-attempt realm, so registration traffic
--      cannot consume (or be measured against) the phone-login budget for the
--      same number. It also keeps the limiter rows from carrying a raw number:
--      the service hashes the number into `identity_key`.
--   3. `platform_signup_requests` holds one live proof per number: the names
--      typed once, the hashed client-request token, the expiry, and the identity
--      the redeemed proof resolved to.
--
-- Nothing here creates a business, membership, branch, wallet, subscription or
-- charge. The identity insert happens only in `src/lib/iam/public-signup.ts`,
-- after a valid, unexpired, signup-purpose code has been redeemed.
--
-- Rollback: drop `platform_signup_requests` and restore the two CHECK
-- constraints to their 0258 / 0250 definitions. The service refuses to run if
-- the purpose or realm is missing, so an older schema fails closed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Purpose: signup is distinct from every existing door
-- ---------------------------------------------------------------------------
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
-- Rate-limit realm: signup has its own send budget
-- ---------------------------------------------------------------------------
-- Migration 0250 left this list at the values in use then; `signup` has to be
-- accepted before the service records the first send, or the code is minted,
-- the SMS is sent, and the rate-limit insert then fails with a constraint
-- violation (the failure mode 0216 exists to document).
ALTER TABLE auth_login_attempts DROP CONSTRAINT IF EXISTS auth_login_attempts_realm_check;
ALTER TABLE auth_login_attempts ADD CONSTRAINT auth_login_attempts_realm_check
  CHECK (realm IN (
    'tenant_password',
    'platform_admin',
    'directory',
    'mfa_challenge',
    'phone_otp',
    'tenant_telegram',
    'signup'
  ));

-- ---------------------------------------------------------------------------
-- The signup proof in flight
-- ---------------------------------------------------------------------------
-- The names live here, not in the verify request body: the person typed them
-- once, and a second request that "confirms" them must not be able to swap the
-- identity's name between the SMS being sent and the code being redeemed.
--
-- `request_token_hash` binds the pending proof to the browser that asked for
-- it. The plaintext token is returned to that browser and never stored; a
-- replayed verify without it cannot redeem the request or receive the
-- onboarding continuation.
CREATE TABLE IF NOT EXISTS platform_signup_requests (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164         text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    first_name         text NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 100),
    last_name          text NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 100),
    -- SHA-256 of the client-held request token, hex. The token itself is never
    -- stored, so a dump of this table cannot be replayed.
    request_token_hash text NOT NULL CHECK (request_token_hash ~ '^[0-9a-f]{64}$'),
    created_at         timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    -- Set when the code is redeemed, or when a resend supersedes the request.
    consumed_at        timestamptz,
    -- The successful proof's stamp. Replaying the same request token inside the
    -- service's short grace period is idempotent; after that it is refused.
    verified_at        timestamptz,
    -- The identity this request resolved to. An existing verified number links
    -- the person's *existing* identity here; it never creates a second one.
    platform_user_id   uuid REFERENCES platform_users(id) ON DELETE SET NULL,
    -- True only for the redemption that inserted the identity.
    identity_created   boolean NOT NULL DEFAULT false,
    CHECK (expires_at > created_at)
);

-- Exactly one live proof per number. A resend supersedes the old row in the
-- same transaction, so an old SMS cannot leave a second attempt budget alive.
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_signup_requests_live
    ON platform_signup_requests (phone_e164)
 WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_platform_signup_requests_phone
    ON platform_signup_requests (phone_e164, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_signup_requests_token
    ON platform_signup_requests (request_token_hash);

COMMENT ON TABLE platform_signup_requests IS
    'One in-flight phone-first signup per number (#1385): the names typed once, the hashed client-request token, and the identity the redeemed proof resolved to. Consumed, never deleted, so a support call can answer what happened.';
COMMENT ON COLUMN platform_signup_requests.request_token_hash IS
    'SHA-256 of the client-held pending-request token. The plaintext is returned only to the browser that started the request and is never stored or logged.';
COMMENT ON COLUMN platform_signup_requests.platform_user_id IS
    'The identity the redeemed request resolved to. An already-verified number links the existing identity; no second identity is created.';
COMMENT ON COLUMN platform_signup_requests.identity_created IS
    'True only when this redemption inserted platform_users. A linked existing identity records false.';

-- ---------------------------------------------------------------------------
-- Platform-only isolation
-- ---------------------------------------------------------------------------
-- A pending proof names a person who is not yet a customer and a business that
-- does not exist; no tenant has any reason to read it. FORCE RLS with the same
-- `platform_only` policy shape as the other pre-tenant platform tables means a
-- tenant connection returns nothing even if a future query forgets a predicate.
ALTER TABLE platform_signup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_signup_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON platform_signup_requests;
CREATE POLICY platform_only ON platform_signup_requests FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());
