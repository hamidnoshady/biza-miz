-- ============================================================================
-- 0306_identity_phone_backfill_repair.sql — ESH-199 / #1384 follow-up.
--
-- 0302_global_identity_phone.sql backfilled a global verified phone from the
-- memberships that had proved one. Its safety rule — "a number is eligible only
-- when exactly one platform identity verified it" — is necessary but not
-- sufficient. It groups by number, so an identity that verified **two different
-- numbers** in two memberships appears once per number, both groups look
-- unambiguous, and `UPDATE … FROM` then picks one of the two arbitrarily. The
-- person's global identity inherits a number chosen by the planner rather than
-- by the person.
--
-- 0302 is already applied (and its bytes are frozen by the migration runner's
-- checksum), so this forward migration does three things:
--
--   1. Reports the second ambiguity shape in
--      `v_platform_verified_phone_identity_conflicts`: identities with more than
--      one distinct verified legacy number. The existing
--      `v_platform_verified_phone_conflicts` continues to report the first shape
--      (one number verified by more than one identity).
--   2. Repairs rows 0302 already wrote for those identities: the value and its
--      stamp are cleared. It only clears a row whose stored value and stamp
--      exactly match one of that identity's legacy verified (number, max
--      verified_at) pairs, so a later real claim — which renews the stamp — is
--      never discarded. Better no global number than an arbitrary one.
--   3. Audits every cleared identity in `platform_identity_events`
--      (`phone_backfill_cleared`). The event carries ids only: the number that
--      was removed is already on the legacy membership rows, and the conflict
--      view is the review surface.
--
-- Nothing is dropped. A fresh install still runs the original 0302 backfill and
-- this migration immediately repairs the same shape, so every database converges
-- to the same state. Re-running the statements is harmless: a second pass finds
-- no matching row because the value is already NULL.
--
-- Rollback: drop `v_platform_verified_phone_identity_conflicts`. The cleared
-- values are still on the legacy memberships, so a reviewed re-backfill can
-- restore a number a human chooses; restoring one automatically is exactly the
-- guess this migration removes. `platform_identity_events` is append-only and
-- keeps the repair record either way.
-- ============================================================================

-- The identity audit table (0303) must accept the repair action before the
-- repair inserts one. Recreate the whole list so a later migration that also
-- extends it can do so from a known set.
ALTER TABLE platform_identity_events
    DROP CONSTRAINT IF EXISTS platform_identity_events_action_check;
ALTER TABLE platform_identity_events
    ADD CONSTRAINT platform_identity_events_action_check
    CHECK (action IN (
        'national_id_set',
        'national_id_cleared',
        'national_id_read',
        'email_verification_issued',
        'email_verified',
        'phone_backfill_cleared'
    ));

-- ---------------------------------------------------------------------------
-- Reporting: one person, several verified legacy numbers
-- ---------------------------------------------------------------------------
-- Read-only and `security_invoker`, like 0302's view: a tenant connection sees
-- only memberships its RLS already allows, while the platform realm can audit
-- every business. The numbers are listed so a reviewed repair can identify the
-- person; nothing here is ever merged automatically.
CREATE OR REPLACE VIEW v_platform_verified_phone_identity_conflicts
    WITH (security_invoker = true) AS
SELECT u.platform_user_id,
       count(DISTINCT u.phone_e164)::int AS number_count,
       array_agg(DISTINCT u.phone_e164 ORDER BY u.phone_e164) AS phone_numbers,
       max(u.phone_verified_at) AS last_verified_at
  FROM users u
 WHERE u.platform_user_id IS NOT NULL
   AND u.phone_e164 IS NOT NULL
   AND u.phone_verified_at IS NOT NULL
 GROUP BY u.platform_user_id
HAVING count(DISTINCT u.phone_e164) > 1;

-- `CREATE OR REPLACE VIEW` resets reloptions; re-assert the invoker's rights
-- explicitly, the same rule every post-0146 view migration in this repo follows.
ALTER VIEW v_platform_verified_phone_identity_conflicts SET (security_invoker = on);

COMMENT ON VIEW v_platform_verified_phone_identity_conflicts IS
    'Platform identities that verified more than one distinct legacy phone number (ESH-199). Their global number was not safely backfillable and is cleared, never guessed.';

-- ---------------------------------------------------------------------------
-- Forward repair of rows 0302 already backfilled
-- ---------------------------------------------------------------------------
-- `verified` is the per-(identity, number) proof, including the exact stamp 0302
-- copied. `ambiguous` is the newly excluded shape. The UPDATE only touches a
-- row that still holds one of those proofs unchanged; a later successful claim
-- overwrote the stamp with `now()` and is therefore left alone.
WITH verified AS (
    SELECT u.platform_user_id,
           u.phone_e164,
           max(u.phone_verified_at) AS verified_at
      FROM users u
     WHERE u.platform_user_id IS NOT NULL
       AND u.phone_e164 IS NOT NULL
       AND u.phone_verified_at IS NOT NULL
     GROUP BY u.platform_user_id, u.phone_e164
),
ambiguous AS (
    SELECT platform_user_id
      FROM verified
     GROUP BY platform_user_id
    HAVING count(*) > 1
),
cleared AS (
    UPDATE platform_users p
       SET phone_e164        = NULL,
           phone_verified_at = NULL,
           updated_at        = now()
      FROM verified v
      JOIN ambiguous a ON a.platform_user_id = v.platform_user_id
     WHERE p.id = v.platform_user_id
       AND p.phone_e164 = v.phone_e164
       AND p.phone_verified_at IS NOT DISTINCT FROM v.verified_at
    RETURNING p.id
)
INSERT INTO platform_identity_events (platform_user_id, action)
SELECT id, 'phone_backfill_cleared'
  FROM cleared;

COMMENT ON COLUMN platform_users.phone_e164 IS
    'Canonical E.164 phone of the global person (ESH-199). Verified only while phone_verified_at is set; changing it clears the stamp. An ambiguous legacy backfill is left NULL rather than guessed (0306).';
