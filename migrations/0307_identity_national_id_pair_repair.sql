-- ============================================================================
-- 0307_identity_national_id_pair_repair.sql — ESH-199 / #1384 follow-up.
--
-- 0303_identity_optional_credentials.sql wrote the national-ID rule as:
--
--     CHECK (
--         (national_id_ciphertext IS NULL AND national_id_bidx IS NULL)
--         OR (national_id_ciphertext ~ '…' AND national_id_bidx ~ '…')
--     )
--
-- In SQL a CHECK passes when its expression is TRUE **or NULL**; only FALSE
-- rejects the row. A one-sided row makes the second branch NULL rather than
-- FALSE — `NULL ~ '…'` is NULL, and `TRUE AND NULL` is NULL — so the old
-- constraint accepted exactly the rows it was meant to stop:
--
--   * ciphertext present, blind index NULL → accepted, and duplicate detection
--     silently stops working for that identity;
--   * blind index present, ciphertext NULL → accepted, and the identity is
--     recorded as having a national ID it cannot read.
--
-- 0303 is already applied, so this forward migration:
--
--   1. Repairs existing one-sided rows by clearing both columns. There is no
--      safe automated way to rebuild a missing blind index or a missing
--      ciphertext inside a migration (the field key and plaintext are not
--      available to SQL), and keeping half a national ID is worse than keeping
--      none. Each cleared identity is audited as `national_id_pair_cleared`.
--   2. Replaces the constraint with an explicit both-present rule. The
--      `IS NOT NULL` checks are the actual fix: the regexes then run on real
--      values, and a NULL branch can no longer pass as an unknown.
--
-- Additive and idempotent: both one-sided rows and the constraint are handled
-- with IF EXISTS / a full replace, and a second pass finds nothing to clear.
--
-- Rollback: drop `platform_users_national_id_shape` and, only if 0303's
-- NULL-tolerant behaviour is genuinely wanted again, re-add its older
-- predicate. The cleared half-pairs cannot be reconstructed from the database
-- (one side was already missing); `platform_identity_events` keeps the record
-- of which identities were affected so the person can re-enter the value.
-- ============================================================================

-- Extend the audit list without dropping the phone-repair action added by 0306.
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
        'phone_backfill_cleared',
        'national_id_pair_cleared'
    ));

-- ---------------------------------------------------------------------------
-- Repair every row the stricter rule would reject
-- ---------------------------------------------------------------------------
-- That is the two one-sided shapes plus any malformed pair an install could
-- only have written with the constraint disabled. The envelope/format checks
-- are repeated here so the repair predicate and the constraint below cannot
-- disagree about what is valid.
WITH repaired AS (
    UPDATE platform_users
       SET national_id_ciphertext = NULL,
           national_id_bidx       = NULL,
           updated_at             = now()
     WHERE NOT (
        (national_id_ciphertext IS NULL AND national_id_bidx IS NULL)
        OR (
            national_id_ciphertext IS NOT NULL
            AND national_id_bidx IS NOT NULL
            AND national_id_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
            AND national_id_bidx ~ '^[0-9a-f]{64}$'
        )
     )
    RETURNING id
)
INSERT INTO platform_identity_events (platform_user_id, action)
SELECT id, 'national_id_pair_cleared'
  FROM repaired;

ALTER TABLE platform_users DROP CONSTRAINT IF EXISTS platform_users_national_id_shape;
ALTER TABLE platform_users
    ADD CONSTRAINT platform_users_national_id_shape
    CHECK (
        (national_id_ciphertext IS NULL AND national_id_bidx IS NULL)
        OR (
            national_id_ciphertext IS NOT NULL
            AND national_id_bidx IS NOT NULL
            AND national_id_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
            AND national_id_bidx ~ '^[0-9a-f]{64}$'
        )
    );

COMMENT ON CONSTRAINT platform_users_national_id_shape ON platform_users IS
    'National ID is either absent on both columns or present on both: ciphertext (v1 AES-256-GCM envelope) and 64-hex blind index (ESH-199, repaired in 0307).';
