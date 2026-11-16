-- ============================================================================
-- 0302_global_identity_phone.sql — ESH-199 / #1384: a verified phone on the
-- global identity.
--
-- `users.phone_e164` is a *membership's* phone: one person in two businesses is
-- two rows, and either can be re-typed without the other noticing. The
-- commercial launch needs one canonical, verified mobile per *person*, because
-- that number is what proves control of the account and what the purchase
-- precondition in src/lib/identity-billing-contract.ts is evaluated against.
--
-- The rules this migration encodes:
--
--   * `platform_users.phone_e164` is E.164 and counts as verified only while
--     `phone_verified_at` is set. The service clears the stamp whenever the
--     number changes, so a value can never be born verified.
--   * Uniqueness is a *partial* index over verified numbers only. Concurrent
--     claims of one number cannot both succeed, while any number of identities
--     may hold a pending/unverified value (an OTP challenge in flight for a
--     number someone else already owns still fails at claim time, by design).
--   * The backfill takes only numbers that map to exactly ONE platform identity.
--     A number verified on two identities is ambiguous; #1384 forbids implicit
--     merges, so those rows are left alone and listed by
--     `v_platform_verified_phone_conflicts` for a reviewed repair.
--   * Nothing is dropped. `users.phone_e164` / `users.phone_verified_at` keep
--     working (dual-read), so every existing login, PIN and OTP path is
--     untouched by this migration.
--
-- Rollback: the columns and index are additive and unused by any read path
-- until the service is called; dropping the index and the three columns returns
-- the schema to 0301. The backfill is idempotent (`platform_users.phone_e164
-- IS NULL` guard), so re-running after a partial failure is safe.
-- ============================================================================

ALTER TABLE platform_users
    ADD COLUMN IF NOT EXISTS phone_e164        text,
    ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz,
    ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- E.164 as the only accepted shape. The service normalises first, so this is a
-- final boundary against a hand-written UPDATE, not the normalisation itself.
ALTER TABLE platform_users
    DROP CONSTRAINT IF EXISTS platform_users_phone_e164_format;
ALTER TABLE platform_users
    ADD CONSTRAINT platform_users_phone_e164_format
    CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$');

-- ---------------------------------------------------------------------------
-- Backfill from the memberships that already proved a number
-- ---------------------------------------------------------------------------
-- `HAVING count(DISTINCT platform_user_id) = 1` is the whole safety property:
-- a number verified on two *different* people is a conflict a human must
-- resolve, never a value this migration may assign to one of them.
WITH verified AS (
    SELECT u.platform_user_id,
           u.phone_e164,
           u.phone_verified_at
      FROM users u
     WHERE u.platform_user_id IS NOT NULL
       AND u.phone_e164 IS NOT NULL
       AND u.phone_verified_at IS NOT NULL
),
unambiguous AS (
    SELECT phone_e164,
           -- No min(uuid) aggregate in Postgres: order by the text form, which
           -- is a total order and stable for one distinct id anyway.
           min(platform_user_id::text)::uuid AS platform_user_id,
           max(phone_verified_at) AS verified_at
      FROM verified
     GROUP BY phone_e164
    HAVING count(DISTINCT platform_user_id) = 1
)
UPDATE platform_users p
   SET phone_e164        = a.phone_e164,
       phone_verified_at = a.verified_at,
       updated_at        = now()
  FROM unambiguous a
 WHERE p.id = a.platform_user_id
   AND p.phone_e164 IS NULL;

-- Created *after* the backfill so a pre-existing duplicate could never make
-- this migration fail; the dedupe above guarantees there is nothing to trip on.
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_users_verified_phone
    ON platform_users (phone_e164)
 WHERE phone_verified_at IS NOT NULL;

-- A lookup path for the login/OTP doors that resolve a verified number back to
-- its person, without scanning unverified values.
CREATE INDEX IF NOT EXISTS idx_platform_users_phone_e164
    ON platform_users (phone_e164)
 WHERE phone_e164 IS NOT NULL;

COMMENT ON COLUMN platform_users.phone_e164 IS
    'Canonical E.164 phone of the global person (ESH-199). Verified only while phone_verified_at is set; changing it clears the stamp.';
COMMENT ON COLUMN platform_users.phone_verified_at IS
    'Proof of control of phone_e164. NULL means the value (if any) is pending or was changed after verification.';
COMMENT ON COLUMN platform_users.email_verified_at IS
    'Proof of control of the identity email. NULL for every pre-ESH-199 identity: an unverified email stays unverified.';
COMMENT ON INDEX idx_platform_users_verified_phone IS
    'Race-safe uniqueness of a verified phone across all identities (ESH-199). Partial: pending values may repeat.';

-- ---------------------------------------------------------------------------
-- Repair surface for ambiguous verified numbers
-- ---------------------------------------------------------------------------
-- Read-only, and `security_invoker` so a tenant connection sees only the
-- memberships RLS already lets it read — a definer-rights view over `users`
-- would leak another business's phone numbers.
CREATE OR REPLACE VIEW v_platform_verified_phone_conflicts
    WITH (security_invoker = true) AS
SELECT u.phone_e164,
       count(DISTINCT u.platform_user_id)::int AS identity_count,
       array_agg(DISTINCT u.platform_user_id)  AS platform_user_ids
  FROM users u
 WHERE u.platform_user_id IS NOT NULL
   AND u.phone_e164 IS NOT NULL
   AND u.phone_verified_at IS NOT NULL
 GROUP BY u.phone_e164
HAVING count(DISTINCT u.platform_user_id) > 1;

-- `CREATE OR REPLACE VIEW` resets `reloptions`, so the inline
-- `security_invoker = true` above is not enough to keep the view on the
-- invoker's rights after a later replace. Re-assert it explicitly — the same
-- rule every post-0146 view migration in this repo follows.
ALTER VIEW v_platform_verified_phone_conflicts SET (security_invoker = on);

COMMENT ON VIEW v_platform_verified_phone_conflicts IS
    'Verified phone numbers held by more than one platform identity (ESH-199). These are deliberately NOT backfilled and need a reviewed repair, never an automatic merge.';
