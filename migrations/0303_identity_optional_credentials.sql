-- ============================================================================
-- 0303_identity_optional_credentials.sql — ESH-199 / #1384: an identity is a
-- person, not necessarily an email-and-password pair.
--
-- The commercial launch supports three shapes of account:
--
--   * password + email (every identity that exists today),
--   * email only — the person signs in with an emailed link or an OTP, and
--     there is no password to steal, reset or hash,
--   * phone only — a verified mobile is the credential; no email address at
--     all (a large share of Iranian small-business owners have no address they
--     read).
--
-- To allow the last two, `email` and `password_hash` stop being NOT NULL. What
-- replaces NOT NULL is a *rule*, not an absence: an identity must have at least
-- one way to be reached (`email` or `phone_e164`), and a password without an
-- email is refused because no password door could ever ask for it.
--
-- `platform_users.email` keeps its UNIQUE constraint: Postgres treats NULLs as
-- distinct, so any number of phone-only identities coexist while two identities
-- still cannot share an address.
--
-- Also here:
--
--   * `platform_email_verifications` — one live token per identity, stored as a
--     SHA-256 hash. Consumption is a single UPDATE whose WHERE clause carries
--     every precondition, so two deliveries of the same link cannot both win.
--     The email the token was issued for is copied onto the row: if the
--     identity's address changed after issue, the stamp is not applied.
--   * `platform_users.national_id_ciphertext` / `national_id_bidx` — the
--     optional national ID, AES-256-GCM under the install's field-encryption
--     master key (`src/lib/field-crypto.ts`), never plaintext. The blind index
--     (HMAC-SHA-256, same key) is what makes "this person is already known" a
--     ciphertext comparison; there is deliberately no plaintext column to
--     drop later.
--   * `platform_identity_events` — an append-only audit of every write to, and
--     privileged read of, those columns. The value is never recorded: the row
--     says who did what, to which identity, and from which business.
--
-- Rollback: additive and unused by any read path until the services are
-- called. `email`/`password_hash` can be made NOT NULL again once no row is
-- NULL (the constraints below guarantee the data can satisfy it, except for a
-- phone-only identity, which by definition has no email).
-- ============================================================================

ALTER TABLE platform_users
    ALTER COLUMN email         DROP NOT NULL,
    ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE platform_users DROP CONSTRAINT IF EXISTS platform_users_credential_channel;
ALTER TABLE platform_users
    ADD CONSTRAINT platform_users_credential_channel
    CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL);

ALTER TABLE platform_users DROP CONSTRAINT IF EXISTS platform_users_password_needs_email;
ALTER TABLE platform_users
    ADD CONSTRAINT platform_users_password_needs_email
    CHECK (password_hash IS NULL OR email IS NOT NULL);

COMMENT ON COLUMN platform_users.password_hash IS
    'bcrypt hash of the identity password, or NULL for a passwordless identity (ESH-199). A NULL hash fails every password comparison closed.';

-- ---------------------------------------------------------------------------
-- Email verification
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_email_verifications (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform_user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    -- The address this token proves. Decided at issue time, never at
    -- consumption time: a changed address must not inherit an older proof.
    email            citext NOT NULL,
    -- SHA-256 of the delivered token, hex. The token itself is never stored.
    token_hash       text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    issued_at        timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    consumed_at      timestamptz,
    CHECK (expires_at > issued_at)
);

-- One live token per identity: issuing a new one consumes the old, so a
-- support call cannot be tricked into honouring a link issued before a change
-- of address.
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_email_verifications_live
    ON platform_email_verifications (platform_user_id)
 WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_platform_email_verifications_expiry
    ON platform_email_verifications (expires_at)
 WHERE consumed_at IS NULL;

COMMENT ON TABLE platform_email_verifications IS
    'One-live-token email proofs for the global identity (ESH-199). Only a SHA-256 hash of the token is stored.';
COMMENT ON COLUMN platform_email_verifications.email IS
    'The address at issue time. Consumption stamps platform_users.email_verified_at only if the address is unchanged.';

-- ---------------------------------------------------------------------------
-- National ID: ciphertext only, plus a blind index for duplicate detection
-- ---------------------------------------------------------------------------
ALTER TABLE platform_users
    ADD COLUMN IF NOT EXISTS national_id_ciphertext text,
    ADD COLUMN IF NOT EXISTS national_id_bidx       text;

ALTER TABLE platform_users DROP CONSTRAINT IF EXISTS platform_users_national_id_shape;
ALTER TABLE platform_users
    ADD CONSTRAINT platform_users_national_id_shape
    CHECK (
        (national_id_ciphertext IS NULL AND national_id_bidx IS NULL)
        OR (national_id_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
            AND national_id_bidx ~ '^[0-9a-f]{64}$')
    );

-- Two identities cannot claim one national ID. The index is over the blind
-- index, so uniqueness is enforced without the database ever seeing the value.
-- Nothing is backfilled: there is no plaintext national ID on platform_users to
-- encrypt, and membership-level `users` carries none.
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_users_national_id_bidx
    ON platform_users (national_id_bidx)
 WHERE national_id_bidx IS NOT NULL;

COMMENT ON COLUMN platform_users.national_id_ciphertext IS
    'Optional national ID, AES-256-GCM (v1 envelope) under the field-encryption master key. Never plaintext (ESH-199).';
COMMENT ON COLUMN platform_users.national_id_bidx IS
    'HMAC-SHA-256 blind index of the national ID, for duplicate detection without decryption.';

-- ---------------------------------------------------------------------------
-- Audit: who touched identity PII, and why
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_identity_events (
    id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    platform_user_id        uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    action                  text NOT NULL CHECK (action IN (
                                'national_id_set',
                                'national_id_cleared',
                                'national_id_read',
                                'email_verification_issued',
                                'email_verified'
                            )),
    -- The acting person, when the action was taken by a person rather than a
    -- delivery (a mail link consumption has no live actor).
    actor_platform_user_id  uuid REFERENCES platform_users(id) ON DELETE SET NULL,
    -- The business whose door the action came through, when there was one.
    actor_business_id       uuid REFERENCES businesses(id) ON DELETE SET NULL,
    created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_identity_events_subject
    ON platform_identity_events (platform_user_id, created_at DESC);

COMMENT ON TABLE platform_identity_events IS
    'Append-only audit of national-ID writes/reads and email verification (ESH-199). Records ids and action only — never the value.';
