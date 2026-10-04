-- ============================================================================
-- 0197_auth_account_security_consolidation.sql
--
-- Account management & authentication security consolidation (Issue #809):
--
--   1. Deterministic primary MFA selection & pending-factor integrity:
--      - Unconfirmed enrolments (`confirmed_at IS NULL`) never hold
--        `is_primary = true` alongside or ahead of a confirmed enrolment.
--      - At most one confirmed enrolment per `(subject_realm, subject_id)` may
--        have `is_primary = true`, enforced by a partial unique index after
--        normalizing any legacy duplicate/missing primary flags.
--
--   2. `auth_password_resets`:
--      - Single-use, short-lived, SHA-256-hashed tokens for user-controlled
--        password reset / recovery / admin invitation across `platform_user`
--        and `platform_admin` realms. Replaces cross-tenant admin force-set
--        passwords so only the account holder chooses their permanent secret.
--
--   3. `auth_admin_sessions`:
--      - Server-side revocable session records for `platform_admins`
--        (mirroring `employee_sessions` for the tenant realm), supporting
--        current-session visibility, single-session revocation, sign-out-others
--        and sign-out-everywhere.
-- ============================================================================

-- 1. Normalize `mfa_enrolments` primary flags before adding the unique index.
--    First, strip `is_primary` from unconfirmed rows when the same subject
--    already has at least one confirmed enrolment.
UPDATE mfa_enrolments u
   SET is_primary = false
 WHERE u.confirmed_at IS NULL
   AND u.is_primary = true
   AND EXISTS (
     SELECT 1 FROM mfa_enrolments c
      WHERE c.subject_realm = u.subject_realm
        AND c.subject_id = u.subject_id
        AND c.confirmed_at IS NOT NULL
   );

--    Second, for every subject that has at least one confirmed enrolment,
--    deterministically pick exactly one confirmed primary (preferring an
--    already-marked primary, then TOTP over SMS, then earliest created_at/id).
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY subject_realm, subject_id
           ORDER BY is_primary DESC,
                    CASE WHEN method = 'totp' THEN 0 ELSE 1 END ASC,
                    created_at ASC,
                    id ASC
         ) AS rn
    FROM mfa_enrolments
   WHERE confirmed_at IS NOT NULL
)
UPDATE mfa_enrolments m
   SET is_primary = (r.rn = 1)
  FROM ranked r
 WHERE m.id = r.id
   AND m.is_primary IS DISTINCT FROM (r.rn = 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mfa_enrolments_single_confirmed_primary
    ON mfa_enrolments (subject_realm, subject_id)
 WHERE is_primary = true AND confirmed_at IS NOT NULL;

-- 2. User-controlled password reset / recovery tokens (exempt global auth table).
CREATE TABLE IF NOT EXISTS auth_password_resets (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_realm      text NOT NULL CHECK (subject_realm IN ('platform_user', 'platform_admin')),
    subject_id         uuid NOT NULL,
    membership_id      uuid REFERENCES users(id) ON DELETE CASCADE,
    email              citext NOT NULL,
    token_hash         text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
    code_hash          text,
    code_expires_at    timestamptz,
    code_attempts      integer NOT NULL DEFAULT 0,
    code_sent_at       timestamptz,
    expires_at         timestamptz NOT NULL,
    used_at            timestamptz,
    revoked_at         timestamptz,
    created_by_id      uuid,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_password_resets_subject_pending
    ON auth_password_resets (subject_realm, subject_id)
 WHERE used_at IS NULL AND revoked_at IS NULL;

-- 3. Server-side session ledger for platform_admins (exempt global auth table).
CREATE TABLE IF NOT EXISTS auth_admin_sessions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id           uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
    token_version      integer NOT NULL DEFAULT 1,
    mfa_verified       boolean NOT NULL DEFAULT false,
    device_label       text CHECK (device_label IS NULL OR char_length(device_label) <= 120),
    ip_address         text CHECK (ip_address IS NULL OR char_length(ip_address) <= 64),
    issued_at          timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    last_seen_at       timestamptz,
    revoked_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_auth_admin_sessions_active
    ON auth_admin_sessions (admin_id, expires_at DESC)
 WHERE revoked_at IS NULL;
