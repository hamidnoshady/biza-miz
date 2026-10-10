-- ============================================================================
-- 0211_auth_hardening.sql — issue #854: purpose-bound OTP challenges, atomic
-- consumption, and a race-free PIN uniqueness index.
--
-- Three separate defects, one table each.
--
-- 1. **`mfa_challenges` was keyed only on (subject_realm, subject_id).** That
--    made a challenge "a code this person has", not "a code this person asked
--    for, for this purpose, sent to this number" — so a code texted to prove
--    number A could be redeemed while asking the server to persist number B
--    (issue #854 P0.8), and a login challenge was indistinguishable from an
--    enrolment or step-up challenge. The columns below make the challenge a
--    transaction: `purpose` says what it authorises, `candidate_phone_e164`
--    says which number it was sent to, and `consumed_at` gives redemption a
--    single transition point instead of a `DELETE` that a concurrent reader
--    could still be looking at. There is deliberately no `business_id`: a
--    challenge is minted before any business is known (the table is RLS-exempt
--    for exactly that reason) and the tenant is resolved after proof.
--
-- 2. **Challenges were consumed by `DELETE` after an unguarded `SELECT`.** Two
--    concurrent verifies could both read the same live row and both succeed
--    (issue #854 P1.17). `consumed_at` plus the `... WHERE consumed_at IS
--    NULL` conditional update in `src/lib/otp-challenge.ts` is the fix; every
--    live-challenge reader filters `consumed_at IS NULL`.
--
-- 3. **PIN uniqueness was a bcrypt scan.** Every candidate was compared
--    against every active hash in the business and then inserted later, so two
--    concurrent writes of the same PIN both passed (issue #854 P2.13). A keyed
--    blind index (HMAC of the PIN under the platform realm secret, scoped by
--    business) restores a real unique constraint without storing the PIN.
--
-- Existing rows are backfilled rather than invalidated: a live challenge from
-- before this migration keeps working for the remainder of its five-minute TTL
-- with `purpose = 'mfa_login'` (what every pre-0211 challenge was used for)
-- and a null candidate phone (the caller must then verify against the subject
-- alone, which is exactly the old behaviour — see `otp-challenge.ts`).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 + 2. Purpose-bound, atomically consumed OTP challenges
-- ---------------------------------------------------------------------------

ALTER TABLE mfa_challenges
    ADD COLUMN purpose               text,
    ADD COLUMN candidate_phone_e164  text,
    ADD COLUMN consumed_at           timestamptz;

-- Backfill before the constraint goes on: every row that predates this
-- migration authorised a second-factor login code, and that is now a named
-- purpose. Rows already past their expiry are left alone — they are dead
-- either way and marking them consumed would be a lie about what happened.
UPDATE mfa_challenges
   SET purpose = 'mfa_login'
 WHERE purpose IS NULL;

ALTER TABLE mfa_challenges
    ALTER COLUMN purpose SET NOT NULL;

-- The vocabulary the application uses. A single CHECK rather than an enum type
-- because it is expected to grow (enrolment, step-up, recovery, …) and a
-- CHECK is a one-line migration where an enum is a two-step dance — the same
-- reasoning `employee_credentials.credential_type`'s sibling columns took.
ALTER TABLE mfa_challenges
    ADD CONSTRAINT mfa_challenges_purpose_check CHECK (purpose IN (
        'login',
        'verify_login_phone',
        'change_login_phone',
        'mfa_login',
        'mfa_enrol_sms',
        'step_up_sms',
        'password_recovery'
    ));

-- A challenge is selected by (subject, purpose), newest first. The old index
-- keyed on created_at alone, which made every lookup a scan of the subject's
-- whole history — including the consumed ones.
DROP INDEX IF EXISTS idx_mfa_challenges_subject;
CREATE INDEX idx_mfa_challenges_subject_purpose
    ON mfa_challenges (subject_realm, subject_id, purpose, created_at DESC)
    WHERE consumed_at IS NULL;

-- Housekeeping for the periodic sweeps: consumed and expired rows have no
-- reader, so let them be found cheaply.
CREATE INDEX idx_mfa_challenges_expiry
    ON mfa_challenges (expires_at)
    WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Race-free PIN uniqueness (blind index)
-- ---------------------------------------------------------------------------

-- The index value is an HMAC of the PIN under the platform realm secret,
-- prefixed with the business id so the same four digits in two businesses
-- produce two different values. It is not a password hash and is not used for
-- authentication — bcrypt still is. It exists only so "is this PIN free?" is
-- a unique-index question rather than an O(n) bcrypt comparison that two
-- concurrent writers can both answer "yes" to.
ALTER TABLE employee_credentials
    ADD COLUMN pin_blind_index text;

COMMENT ON COLUMN employee_credentials.pin_blind_index IS
    'HMAC(platform realm secret, business_id || pin). Keyed, business-scoped '
    'lookup key for PIN uniqueness only (issue #854 P2.13). Never used to '
    'authenticate and never stored in place of secret_hash.';

CREATE UNIQUE INDEX idx_employee_credentials_pin_blind_index
    ON employee_credentials (business_id, pin_blind_index)
    WHERE credential_type = 'pin' AND status = 'active' AND pin_blind_index IS NOT NULL;

-- The pre-0211 rows are bcrypt-only, so they cannot be backfilled (there is no
-- plaintext to hash, which is the point). They stay out of the index by
-- `pin_blind_index IS NULL` and are re-keyed the next time the PIN is set —
-- `setPin` writes the index on every future rotation, so the gap closes as
-- businesses rotate PINs rather than needing a plaintext-recovery step that
-- does not exist.

-- ---------------------------------------------------------------------------
-- 4. Password recovery is delivered, not handed out (P0.3)
-- ---------------------------------------------------------------------------

-- `auth_password_resets` already stored only the token's hash, so a database
-- read could never yield a usable link. The hole was one level up: the *API*
-- returned the plaintext token to whichever tenant administrator triggered the
-- reset, and that token is directly spendable to change the shared
-- `platform_users` password — an admin in Business A could take over an
-- identity's password in Businesses B and C.
--
-- The token is now texted to the account holder's own verified phone number.
-- These columns are the audit trail of that delivery: which channel was used,
-- where it went (masked — the full number is already on `users`), and when. The
-- API returns exactly this, never the token.
ALTER TABLE auth_password_resets
    ADD COLUMN delivery_channel       text CHECK (delivery_channel IS NULL OR delivery_channel IN ('sms', 'manual')),
    ADD COLUMN delivery_target_masked text,
    ADD COLUMN delivered_at           timestamptz;

COMMENT ON COLUMN auth_password_resets.delivery_channel IS
    'How the reset credential reached the account holder (issue #854 P0.3). '
    'NULL means it was issued before delivery tracking existed. The raw token '
    'is never returned to a tenant administrator on any channel.';

-- ---------------------------------------------------------------------------
-- 5. Where a session came from, for the device card (P2.27)
-- ---------------------------------------------------------------------------

-- The session list could say *when* a session was issued and *where* it was
-- used, but not *how* it was established — so «نشست فعلی» was the only row a
-- member could reason about. One nullable column is cheaper than inferring it
-- from the cookie's claims after the fact, and NULL is honest for the rows that
-- predate this migration.
ALTER TABLE employee_sessions
    ADD COLUMN login_method text
    CHECK (login_method IS NULL OR login_method IN (
        'password', 'phone_otp', 'pin', 'webauthn', 'invitation', 'impersonation'
    )),
    ADD COLUMN user_agent text;

-- ---------------------------------------------------------------------------
-- 6. Invitations carry an explicit branch policy (P2.11) and are re-validated
--    at acceptance (P0.5)
-- ---------------------------------------------------------------------------

-- `location_ids` already existed, but an *empty* list was ambiguous: it could
-- mean "every branch" (what the code did) or "the inviter never saw the field"
-- (what usually happened — the invite form only asked for name/email/role).
-- One of those readings grants far more access than the inviter intended, so
-- the policy is now stored explicitly rather than inferred from an empty array.
--
--   all      — every branch, including ones added later
--   selected — exactly `location_ids`
--   home     — the named `default_location_id` (also the home branch)
--   none     — no branch assignment (roaming, e.g. an owner)
--
-- NULL means the invitation predates this migration; its stored `location_ids`
-- are interpreted with the old rule (empty ⇒ all) so acceptance behaviour does
-- not change for a link already in somebody's inbox.
ALTER TABLE invitations
    ADD COLUMN location_scope location_scope,
    ADD COLUMN default_location_id uuid,
    -- P2.12: `users.custom_role_id` existed, the invitation payload did not, so
    -- an invitation for a role with a custom role attached silently granted the
    -- plain preset instead. Stored as a reference rather than a copied
    -- permission set: the role's contents at acceptance time are what the
    -- cloud owns, and a link in an inbox must not pin a stale snapshot.
    ADD COLUMN custom_role_id uuid REFERENCES tenant_roles(id) ON DELETE SET NULL;

COMMENT ON COLUMN invitations.location_scope IS
    'Explicit branch policy (issue #854 P2.11). NULL = pre-0211 invitation, '
    'read with the legacy rule "empty location_ids means all branches".';

COMMENT ON COLUMN invitations.custom_role_id IS
    'Custom role the invitation grants (issue #854 P2.12). NULL = plain preset.';
