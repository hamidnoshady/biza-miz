-- Issue #885 — platform-wide login and authentication hardening.
--
-- Three separate pieces of persistent state, all of which the login door
-- needs in order to stop making decisions from data it cannot trust:
--
--   1. `mfa_challenges` gains the columns that bind a phone-OTP code to the
--      one ceremony that minted it (L02) and the marker that lets a code be
--      consumed exactly once under concurrency (L03).
--   2. `trusted_devices` — the seven-day, account+tenant+device trust the
--      audit's confirmed policy requires. Deliberately a new table rather
--      than a column on `users`: `users.otp_login_at` is per *membership*,
--      which is precisely the shape the policy rejects, because it lets one
--      verified phone exempt every device that membership ever logs in from.
--   3. The send quota keeps using `auth_login_attempts`, but the check-and-record
--      is now wrapped in a single transaction behind an advisory lock in
--      `reserveOtpSend`, so two simultaneous requests can no longer both read
--      "under the limit" and both send.
--
-- Plus one repair the audit did not list, found by running the phone-OTP send
-- path against a real database rather than reading it:
--
--   4. `auth_login_attempts` never accepted `realm = 'phone_otp'`. Migration
--      0070 constrained the column to ('tenant_password','platform_admin',
--      'directory') and 0078 widened it only as far as adding 'mfa_challenge'.
--      `sendEmployeePhoneOtp` has nonetheless been inserting 'phone_otp' since
--      Phase 42, so that INSERT threw a check-constraint violation on every
--      send — *after* the SMS had already gone out, and outside any try/catch.
--      Two consequences, both live:
--
--        - the route caught the throw and answered 502 `sms_dispatch_failed`
--          for a message that had in fact been delivered, so members were told
--          the send failed and invited to retry;
--        - no row was ever recorded, so `checkPhoneOtpRateLimit` always read an
--          empty budget and the per-membership ceiling of 1/minute, 5/hour,
--          20/day never applied at all. Nothing capped what one membership
--          could spend.
--
--      Verified against PostgreSQL 18.4: the insert is rejected by
--      `auth_login_attempts_realm_check`, and `outcome = 'reserved'` by
--      `auth_login_attempts_outcome_check`. Both are widened below.
--
-- Forward-only, as every migration here is.

-- (4) above. 'phone_otp' is the realm the phone door has always written;
-- 'reserved' is the outcome `reserveOtpSend` now records, so that a
-- reservation taken and then refunded (a dispatch that failed) is
-- distinguishable from one that was spent.
ALTER TABLE auth_login_attempts DROP CONSTRAINT auth_login_attempts_realm_check;
ALTER TABLE auth_login_attempts ADD CONSTRAINT auth_login_attempts_realm_check
    CHECK (realm IN ('tenant_password','platform_admin','directory','mfa_challenge','phone_otp'));

ALTER TABLE auth_login_attempts DROP CONSTRAINT auth_login_attempts_outcome_check;
ALTER TABLE auth_login_attempts ADD CONSTRAINT auth_login_attempts_outcome_check
    CHECK (outcome IN ('failed','success','unlocked','reserved'));

-- ---------------------------------------------------------------------------
-- 1. Phone-OTP challenge binding and one-time consumption
-- ---------------------------------------------------------------------------
--
-- Before this, `mfa_challenges` identified a phone-OTP code by
-- `(subject_realm, subject_id)` alone and verification read "the newest live
-- row for this member". Two consequences, both traced in source:
--
--   * The pending token carried the candidate number but nothing naming the
--     challenge it was for, so proof taken in one ceremony (say, attaching a
--     number during a PIN login) could be replayed to satisfy a different
--     pending token for the same member — the code is the same six digits.
--   * Consumption was SELECT / compare / DELETE. Two concurrent valid
--     submissions both passed the SELECT before either DELETEd, so both were
--     told "verified".
--
-- `business_id` is the tenant the challenge belongs to, so a challenge row
-- can never be read back across a tenant boundary even if a pending token is
-- presented on the wrong origin. `purpose` distinguishes the two things a
-- phone-OTP code is asked to do — proving a login, or proving ownership of a
-- number that is about to be attached — which is the distinction the replay
-- above crossed. `destination` is the number the code was actually sent to,
-- so verification can refuse a token that has since been re-pointed at a
-- different number. `consumed_at` is the soft-consume marker: consumption is
-- one conditional UPDATE that returns zero rows for the second caller, which
-- is what makes single use true under concurrency instead of merely likely.
--
-- All four are nullable and unconstrained by default because this table is
-- shared with the MFA interstitial (`platform_user` / `platform_admin`
-- realms), whose challenges are bound by their own pending token and gain
-- nothing from these columns. Only the `employee_phone` realm writes them.
ALTER TABLE mfa_challenges
    ADD COLUMN business_id  uuid,
    ADD COLUMN purpose      text,
    ADD COLUMN destination  text,
    ADD COLUMN consumed_at  timestamptz;

-- Verification now looks the challenge up by id, and the send path retires
-- every older live challenge for the same subject — both are index scans on
-- the columns they filter by rather than the (realm, subject, created_at)
-- ordering index above.
CREATE INDEX idx_mfa_challenges_employee_phone
    ON mfa_challenges (subject_realm, subject_id, business_id)
    WHERE subject_realm = 'employee_phone' AND consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Trusted devices — seven days, scoped to account + tenant + device
-- ---------------------------------------------------------------------------
--
-- The confirmed policy: at every new login, require the account's applicable
-- OTP and/or MFA challenges *unless* this exact device holds a valid trust
-- entry for that account and tenant. After a login that completed every
-- required factor, the member may trust the device for seven days; during
-- that window routine OTP/MFA is skipped on it, and after it expires — or on
-- any other device — verification is required again.
--
-- What this is NOT:
--   * Not a session. `employee_sessions` expiry and trust expiry are separate
--     clocks; a live trust entry mints nothing and authorises nothing.
--   * Not a primary credential. Trust only waives the routine *assurance*
--     challenge (the periodic phone re-verification on the PIN door, the MFA
--     second factor on the password door). An approved primary credential —
--     PIN, password or WebAuthn — is still required on every login.
--   * Not a browser flag. The credential is `token`, a 256-bit random secret
--     held in a host-scoped HttpOnly cookie; only its HMAC-SHA256 digest is
--     stored here, so a database read cannot be replayed as device trust. A
--     label, a fingerprint or the remembered-door preference in
--     `login-door.ts` establish nothing.
--
-- `factor_summary` records which factors the trust was earned with. It is
-- diagnostics only and is never consulted as authorization: trust is
-- invalidated by revocation, expiry and the security events below, not by
-- re-litigating how it was granted.
CREATE TABLE trusted_devices (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The global identity the membership is bound to, when it has one. Kept
    -- so a global account disable or credential change can find and revoke
    -- the trust it earned, which the membership row alone cannot express.
    platform_user_id uuid,
    -- HMAC-SHA256 of the opaque token, hex. Never the token.
    token_hash       text NOT NULL,
    -- The paired-terminal token this trust was issued on, when the browser
    -- carries one. Informational — the cookie token is the credential.
    device_token     text,
    device_label     text,
    factor_summary   text,
    trusted_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    -- Revocation is soft, so the row can say why and when it stopped being
    -- trusted; "revoked" and "expired" are different facts for the user
    -- reading their own device list.
    revoked_at       timestamptz,
    revoked_reason   text,
    last_seen_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- Token lookup: one hash names exactly one row, across tenants. The digest is
-- of a 256-bit secret, so a global unique index cannot be used to enumerate
-- anything.
CREATE UNIQUE INDEX idx_trusted_devices_token ON trusted_devices (token_hash);

-- The device-management screen lists one member's devices; the assurance
-- evaluator asks "is this (business, user) pair trusted on this device?".
CREATE INDEX idx_trusted_devices_member
    ON trusted_devices (business_id, user_id, expires_at);

-- Revoking everything a global identity earned, in one statement.
CREATE INDEX idx_trusted_devices_platform_user
    ON trusted_devices (platform_user_id)
    WHERE platform_user_id IS NOT NULL;

ALTER TABLE trusted_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE trusted_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON trusted_devices FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
