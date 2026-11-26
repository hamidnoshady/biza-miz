-- ============================================================================
-- 0322_global_identity_integrity_hardening.sql — ESH-199 / #1384 completion:
-- normalized verified-phone conflict detection & repair, national-ID / phone
-- pair invariants, FORCE RLS on 0303 identity tables, and append-only audit
-- enforcement.
--
-- Why a forward migration rather than editing 0302 / 0303 / 0306 / 0307:
-- those migrations are already applied on deployed environments and frozen by
-- schema_migrations checksums. Everything here is additive, idempotent, and
-- converges both fresh installs and already-migrated databases to the same
-- invariants without rewriting history or merging accounts.
--
-- What this migration closes:
--
--   1. Phone normalization & mobile-only backfills (0302 / 0306 follow-up):
--      `users.phone_e164` predates E.164 format constraints (0139) and may
--      contain Persian/Arabic-Indic digits, national `09…` / `0098…` / `+9809…`
--      spellings, separators, or landlines (`+9821…`). Grouping on raw text:
--        * missed cross-identity conflicts when two identities verified the
--          same mobile in different spellings (and let 0302 backfill the E.164
--          side);
--        * falsely flagged one identity holding `0912…` and `+98912…` in two
--          businesses as a multi-number conflict; and
--        * allowed 0302 to backfill verified landlines (`+9821…`), wedging both
--          `claimVerifiedPhone` (`identity_phone_locked`) and checkout
--          (`phone_not_mobile`).
--      `canonical_iran_mobile_e164(text)` mirrors `src/lib/phone.ts`
--      (`normalizePhone` + `kind = 'mobile'`) in immutable SQL so conflict
--      views and repair queries compare canonical mobiles rather than raw text.
--
--   2. Phone verification stamp pairing:
--      Enforces `phone_verified_at IS NULL OR phone_e164 IS NOT NULL` on
--      `platform_users` after clearing any orphaned stamp.
--
--   3. Row-level security & append-only audit on 0303 global identity tables:
--      Enables and forces `platform_only` RLS (`app_rls_bypass()`) on
--      `platform_email_verifications` and `platform_identity_events`, adds a
--      constrained PII-free `reason_code` slug column, extends the audited
--      action set, and installs a DB trigger forbidding UPDATE or direct DELETE
--      on `platform_identity_events` (permitting FK cascade only when the
--      parent `platform_users` row itself has been deleted).
--
-- Rollback:
--   Drop `v_platform_verified_phone_anomalies`, restore the pre-0322 definitions
--   of `v_platform_verified_phone_conflicts` and
--   `v_platform_verified_phone_identity_conflicts`, drop trigger
--   `trg_platform_identity_events_append_only` and function
--   `guard_platform_identity_events_append_only`, drop constraint
--   `platform_users_phone_verification_requires_phone`, and drop function
--   `canonical_iran_mobile_e164(text)`. Cleared ambiguous/non-mobile backfills
--   remain preserved on `users` and audited in `platform_identity_events`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Canonical Iranian mobile normalizer (mirrors src/lib/phone.ts)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION canonical_iran_mobile_e164(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
    trimmed    text;
    translated text;
    digits     text;
BEGIN
    IF raw IS NULL THEN
        RETURN NULL;
    END IF;

    trimmed := btrim(raw);
    IF trimmed = '' THEN
        RETURN NULL;
    END IF;

    -- Translate Persian (U+06F0..U+06F9) and Arabic-Indic (U+0660..U+0669) digits.
    translated := translate(
        trimmed,
        '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩',
        '01234567890123456789'
    );

    -- Reject values containing alphabetic words so free-text notes with digits
    -- are never mistaken for canonical phone numbers, while allowing standard
    -- phone punctuation and bidi marks.
    IF translated ~ '[A-Za-z\u0600-\u065f\u066a-\u06ef\u06fa-\u06ff]' THEN
        RETURN NULL;
    END IF;

    digits := regexp_replace(translated, '[^0-9]+', '', 'g');
    IF digits = '' THEN
        RETURN NULL;
    END IF;

    -- Sequential prefix reduction matching `nationalSignificant` in src/lib/phone.ts:
    -- 0098… -> 98… -> strip 98 when >= 12 digits -> strip trunk 0s (including +9809…).
    IF digits LIKE '0098%' THEN
        digits := substr(digits, 3);
    END IF;
    IF digits LIKE '98%' AND char_length(digits) >= 12 THEN
        digits := substr(digits, 3);
    END IF;
    IF digits LIKE '0%' THEN
        digits := regexp_replace(digits, '^0+', '');
    END IF;

    IF digits ~ '^9[0-9]{9}$' THEN
        RETURN '+98' || digits;
    END IF;

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION canonical_iran_mobile_e164(text) IS
    'Canonical +989XXXXXXXXX normalizer for Iranian mobile numbers (ESH-199). Accepts Persian/Arabic digits and national/international prefixes; returns NULL for landlines and invalid strings.';

-- ---------------------------------------------------------------------------
-- 2. Identity audit extensions, FORCE RLS, and append-only protection
-- ---------------------------------------------------------------------------
ALTER TABLE platform_identity_events
    ADD COLUMN IF NOT EXISTS reason_code text;

ALTER TABLE platform_identity_events
    DROP CONSTRAINT IF EXISTS platform_identity_events_reason_code_check;
ALTER TABLE platform_identity_events
    ADD CONSTRAINT platform_identity_events_reason_code_check
    CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{1,63}$');

COMMENT ON COLUMN platform_identity_events.reason_code IS
    'Optional lowercase machine slug explaining a migration or operator repair. Constrained to ^[a-z][a-z0-9_]{1,63}$ so numeric national IDs, phones, emails, and ciphertexts can never be stored here.';

ALTER TABLE platform_identity_events
    DROP CONSTRAINT IF EXISTS platform_identity_events_action_check;
ALTER TABLE platform_identity_events
    ADD CONSTRAINT platform_identity_events_action_check CHECK (action IN (
        'national_id_set',
        'national_id_cleared',
        'national_id_read',
        'email_verification_issued',
        'email_verified',
        'phone_backfill_cleared',
        'national_id_pair_cleared',
        'email_changed',
        'email_cleared',
        'phone_backfilled_normalized',
        'phone_conflict_repaired',
        'national_id_remediated'
    ));

ALTER TABLE platform_email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_email_verifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON platform_email_verifications;
CREATE POLICY platform_only ON platform_email_verifications
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

ALTER TABLE platform_identity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_identity_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON platform_identity_events;
CREATE POLICY platform_only ON platform_identity_events
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

CREATE OR REPLACE FUNCTION guard_platform_identity_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Permit PostgreSQL's internal FK ON DELETE SET NULL transitions on
        -- actor/business columns ONLY when the referenced parent row has
        -- already been deleted and every immutable audit field is unchanged.
        IF NEW.id = OLD.id
           AND NEW.platform_user_id = OLD.platform_user_id
           AND NEW.action = OLD.action
           AND NEW.created_at = OLD.created_at
           AND NEW.reason_code IS NOT DISTINCT FROM OLD.reason_code
           AND (
               NEW.actor_platform_user_id IS NOT DISTINCT FROM OLD.actor_platform_user_id
               OR (
                   OLD.actor_platform_user_id IS NOT NULL
                   AND NEW.actor_platform_user_id IS NULL
                   AND NOT EXISTS (SELECT 1 FROM public.platform_users WHERE id = OLD.actor_platform_user_id)
               )
           )
           AND (
               NEW.actor_platform_admin_id IS NOT DISTINCT FROM OLD.actor_platform_admin_id
               OR (
                   OLD.actor_platform_admin_id IS NOT NULL
                   AND NEW.actor_platform_admin_id IS NULL
                   AND NOT EXISTS (SELECT 1 FROM public.platform_admins WHERE id = OLD.actor_platform_admin_id)
               )
           )
           AND (
               NEW.actor_business_id IS NOT DISTINCT FROM OLD.actor_business_id
               OR (
                   OLD.actor_business_id IS NOT NULL
                   AND NEW.actor_business_id IS NULL
                   AND NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = OLD.actor_business_id)
               )
           )
           AND (
               NEW.actor_platform_user_id IS DISTINCT FROM OLD.actor_platform_user_id
               OR NEW.actor_platform_admin_id IS DISTINCT FROM OLD.actor_platform_admin_id
               OR NEW.actor_business_id IS DISTINCT FROM OLD.actor_business_id
           )
        THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION 'platform_identity_events_append_only: identity audit events cannot be updated'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        -- Permit FK ON DELETE CASCADE only when the parent platform_users row
        -- has already been deleted in the enclosing statement.
        IF EXISTS (SELECT 1 FROM public.platform_users WHERE id = OLD.platform_user_id) THEN
            RAISE EXCEPTION 'platform_identity_events_append_only: identity audit events cannot be deleted while identity exists'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_platform_identity_events_append_only ON platform_identity_events;
CREATE TRIGGER trg_platform_identity_events_append_only
    BEFORE UPDATE OR DELETE ON platform_identity_events
    FOR EACH ROW
    EXECUTE FUNCTION guard_platform_identity_events_append_only();

-- ---------------------------------------------------------------------------
-- 3. Normalized read-only conflict & anomaly views (security_invoker = on)
-- ---------------------------------------------------------------------------
-- Preserves exact leading columns of 0302 (`phone_e164`, `identity_count`,
-- `platform_user_ids`) and appends normalized diagnostic metadata at the end.
CREATE OR REPLACE VIEW v_platform_verified_phone_conflicts
    WITH (security_invoker = true) AS
WITH normalized AS (
    SELECT u.platform_user_id,
           u.business_id,
           u.phone_e164 AS raw_phone,
           canonical_iran_mobile_e164(u.phone_e164) AS canonical_phone,
           u.phone_verified_at
      FROM users u
     WHERE u.platform_user_id IS NOT NULL
       AND u.phone_e164 IS NOT NULL
       AND u.phone_verified_at IS NOT NULL
)
SELECT n.canonical_phone AS phone_e164,
       count(DISTINCT n.platform_user_id)::int AS identity_count,
       array_agg(DISTINCT n.platform_user_id ORDER BY n.platform_user_id) AS platform_user_ids,
       array_agg(DISTINCT n.raw_phone ORDER BY n.raw_phone) AS raw_phone_numbers,
       array_agg(DISTINCT n.business_id ORDER BY n.business_id) AS business_ids,
       count(*)::int AS membership_count,
       max(n.phone_verified_at) AS last_verified_at
  FROM normalized n
 WHERE n.canonical_phone IS NOT NULL
 GROUP BY n.canonical_phone
HAVING count(DISTINCT n.platform_user_id) > 1;

ALTER VIEW v_platform_verified_phone_conflicts SET (security_invoker = on);

COMMENT ON VIEW v_platform_verified_phone_conflicts IS
    'Canonical verified mobile numbers claimed by more than one platform identity across memberships, normalized across Persian/Arabic digits and legacy prefixes (ESH-199).';

-- Preserves exact leading columns of 0306 (`platform_user_id`, `number_count`,
-- `phone_numbers`, `last_verified_at`) while grouping on canonical mobiles so
-- format variants of one number do not false-positive and cross-format distinct
-- numbers are caught.
CREATE OR REPLACE VIEW v_platform_verified_phone_identity_conflicts
    WITH (security_invoker = true) AS
WITH normalized AS (
    SELECT u.platform_user_id,
           u.business_id,
           u.phone_e164 AS raw_phone,
           canonical_iran_mobile_e164(u.phone_e164) AS canonical_phone,
           u.phone_verified_at
      FROM users u
     WHERE u.platform_user_id IS NOT NULL
       AND u.phone_e164 IS NOT NULL
       AND u.phone_verified_at IS NOT NULL
)
SELECT n.platform_user_id,
       count(DISTINCT n.canonical_phone)::int AS number_count,
       array_agg(DISTINCT n.canonical_phone ORDER BY n.canonical_phone) AS phone_numbers,
       max(n.phone_verified_at) AS last_verified_at,
       array_agg(DISTINCT n.raw_phone ORDER BY n.raw_phone) AS raw_phone_numbers,
       array_agg(DISTINCT n.business_id ORDER BY n.business_id) AS business_ids,
       count(*)::int AS membership_count
  FROM normalized n
 WHERE n.canonical_phone IS NOT NULL
 GROUP BY n.platform_user_id
HAVING count(DISTINCT n.canonical_phone) > 1;

ALTER VIEW v_platform_verified_phone_identity_conflicts SET (security_invoker = on);

COMMENT ON VIEW v_platform_verified_phone_identity_conflicts IS
    'Platform identities with more than one distinct canonical verified mobile number across memberships (ESH-199).';

-- Surfaces non-mobile (landline) or unparseable verified phone strings on
-- memberships or global identities so operators can inspect them without
-- silent data loss.
CREATE OR REPLACE VIEW v_platform_verified_phone_anomalies
    WITH (security_invoker = true) AS
SELECT 'membership'::text AS source_scope,
       u.platform_user_id,
       u.business_id,
       u.id AS membership_id,
       u.phone_e164 AS raw_phone,
       canonical_iran_mobile_e164(u.phone_e164) AS canonical_mobile,
       u.phone_verified_at AS verified_at,
       CASE
           WHEN u.phone_e164 ~ '^\+98[1-8][0-9]{5,10}$' OR u.phone_e164 ~ '^0[1-8][0-9]{5,10}$'
               THEN 'landline_not_mobile'
           ELSE 'unparseable_phone'
       END AS anomaly_kind
  FROM users u
 WHERE u.platform_user_id IS NOT NULL
   AND u.phone_e164 IS NOT NULL
   AND u.phone_verified_at IS NOT NULL
   AND canonical_iran_mobile_e164(u.phone_e164) IS NULL
UNION ALL
SELECT 'platform_user'::text AS source_scope,
       p.id AS platform_user_id,
       NULL::uuid AS business_id,
       NULL::uuid AS membership_id,
       p.phone_e164 AS raw_phone,
       canonical_iran_mobile_e164(p.phone_e164) AS canonical_mobile,
       p.phone_verified_at AS verified_at,
       CASE
           WHEN canonical_iran_mobile_e164(p.phone_e164) IS NULL THEN 'non_mobile_global_phone'
           ELSE 'non_canonical_global_phone'
       END AS anomaly_kind
  FROM platform_users p
 WHERE p.phone_e164 IS NOT NULL
   AND (
       canonical_iran_mobile_e164(p.phone_e164) IS NULL
       OR p.phone_e164 <> canonical_iran_mobile_e164(p.phone_e164)
   );

ALTER VIEW v_platform_verified_phone_anomalies SET (security_invoker = on);

COMMENT ON VIEW v_platform_verified_phone_anomalies IS
    'Verified membership or global identity phone rows that are landlines, non-canonical spellings, or unparseable values (ESH-199).';

-- ---------------------------------------------------------------------------
-- 4. Forward corrective repair of global verified-phone invariants
-- ---------------------------------------------------------------------------
-- 4a. Clear any orphaned verification stamp where phone_e164 is NULL, then
--     enforce the pairing invariant at the schema level.
WITH orphan_stamps AS (
    UPDATE platform_users p
       SET phone_verified_at = NULL,
           updated_at        = now()
     WHERE p.phone_e164 IS NULL
       AND p.phone_verified_at IS NOT NULL
    RETURNING p.id
)
INSERT INTO platform_identity_events (platform_user_id, action, reason_code)
SELECT id, 'phone_backfill_cleared', 'orphan_phone_verification_stamp'
  FROM orphan_stamps;

ALTER TABLE platform_users
    DROP CONSTRAINT IF EXISTS platform_users_phone_verification_requires_phone;
ALTER TABLE platform_users
    ADD CONSTRAINT platform_users_phone_verification_requires_phone
    CHECK (phone_verified_at IS NULL OR phone_e164 IS NOT NULL);

-- 4b. Clear non-mobile phones (e.g. landlines `+9821…`) that 0302 backfilled
--     onto email-reachable identities, unlocking `claimVerifiedPhone` so the
--     person can verify a real mobile. Guarded by `p.email IS NOT NULL` so
--     `platform_users_credential_channel` can never be violated.
WITH cleared_non_mobile AS (
    UPDATE platform_users p
       SET phone_e164        = NULL,
           phone_verified_at = NULL,
           updated_at        = now()
     WHERE p.phone_e164 IS NOT NULL
       AND canonical_iran_mobile_e164(p.phone_e164) IS NULL
       AND p.email IS NOT NULL
    RETURNING p.id
)
INSERT INTO platform_identity_events (platform_user_id, action, reason_code)
SELECT id, 'phone_backfill_cleared', 'non_mobile_phone'
  FROM cleared_non_mobile;

-- 4c. Clear 0302 backfills that became ambiguous once legacy formats and
--     Persian/Arabic digits are normalized (cross-identity shared number or
--     multi-number single identity), unless already resolved by an audited
--     operator repair or renewed by a later live verification.
WITH legacy_stamps AS (
    SELECT u.platform_user_id,
           canonical_iran_mobile_e164(u.phone_e164) AS canonical_phone,
           max(u.phone_verified_at) AS max_verified_at
      FROM users u
     WHERE u.platform_user_id IS NOT NULL
       AND u.phone_e164 IS NOT NULL
       AND u.phone_verified_at IS NOT NULL
       AND canonical_iran_mobile_e164(u.phone_e164) IS NOT NULL
     GROUP BY u.platform_user_id, canonical_iran_mobile_e164(u.phone_e164)
),
conflicted_identities AS (
    SELECT platform_user_id
      FROM v_platform_verified_phone_identity_conflicts
    UNION
    SELECT unnest(platform_user_ids) AS platform_user_id
      FROM v_platform_verified_phone_conflicts
),
cleared_ambiguous AS (
    UPDATE platform_users p
       SET phone_e164        = NULL,
           phone_verified_at = NULL,
           updated_at        = now()
      FROM legacy_stamps ls
      JOIN conflicted_identities ci ON ci.platform_user_id = ls.platform_user_id
     WHERE p.id = ls.platform_user_id
       AND p.email IS NOT NULL
       AND p.phone_e164 IS NOT NULL
       AND canonical_iran_mobile_e164(p.phone_e164) = ls.canonical_phone
       AND p.phone_verified_at IS NOT DISTINCT FROM ls.max_verified_at
       AND NOT EXISTS (
           SELECT 1
             FROM platform_identity_events e
            WHERE e.platform_user_id = p.id
              AND e.action = 'phone_conflict_repaired'
       )
    RETURNING p.id
)
INSERT INTO platform_identity_events (platform_user_id, action, reason_code)
SELECT id, 'phone_backfill_cleared', 'normalized_phone_conflict'
  FROM cleared_ambiguous;

-- 4d. Normalize non-canonical global mobile spellings (e.g. `+980912…` ->
--     `+98912…`) and backfill unambiguous single-mobile identities whose
--     legacy verified rows differed only in formatting/digits (which 0302
--     could not write raw or 0306 cleared as raw-string duplicates).
WITH verified_rows AS (
    SELECT u.platform_user_id,
           u.phone_e164 AS raw_phone,
           canonical_iran_mobile_e164(u.phone_e164) AS canonical_phone,
           u.phone_verified_at
      FROM users u
     WHERE u.platform_user_id IS NOT NULL
       AND u.phone_e164 IS NOT NULL
       AND u.phone_verified_at IS NOT NULL
),
clean_identities AS (
    SELECT platform_user_id,
           min(canonical_phone) AS canonical_phone,
           max(phone_verified_at) AS verified_at
      FROM verified_rows
     GROUP BY platform_user_id
    HAVING count(*) FILTER (WHERE canonical_phone IS NULL) = 0
       AND count(DISTINCT canonical_phone) = 1
),
globally_unambiguous AS (
    SELECT vr.canonical_phone,
           min(vr.platform_user_id::text)::uuid AS platform_user_id
      FROM verified_rows vr
     WHERE vr.canonical_phone IS NOT NULL
     GROUP BY vr.canonical_phone
    HAVING count(DISTINCT vr.platform_user_id) = 1
),
eligible AS (
    SELECT ci.platform_user_id,
           ci.canonical_phone,
           ci.verified_at
      FROM clean_identities ci
      JOIN globally_unambiguous gu
        ON gu.platform_user_id = ci.platform_user_id
       AND gu.canonical_phone = ci.canonical_phone
     WHERE NOT EXISTS (
         SELECT 1
           FROM platform_users other
          WHERE other.id <> ci.platform_user_id
            AND other.phone_e164 = ci.canonical_phone
            AND other.phone_verified_at IS NOT NULL
     )
),
backfilled AS (
    UPDATE platform_users p
       SET phone_e164        = e.canonical_phone,
           phone_verified_at = COALESCE(p.phone_verified_at, e.verified_at),
           updated_at        = now()
      FROM eligible e
     WHERE p.id = e.platform_user_id
       AND (
           (p.phone_e164 IS NULL AND p.phone_verified_at IS NULL)
           OR (
               p.phone_e164 IS NOT NULL
               AND p.phone_e164 <> e.canonical_phone
               AND canonical_iran_mobile_e164(p.phone_e164) = e.canonical_phone
           )
       )
    RETURNING p.id
)
INSERT INTO platform_identity_events (platform_user_id, action, reason_code)
SELECT id, 'phone_backfilled_normalized', 'canonical_legacy_mobile'
  FROM backfilled;
