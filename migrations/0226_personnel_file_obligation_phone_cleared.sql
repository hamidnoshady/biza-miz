-- 0226_personnel_file_obligation_phone_cleared.sql
--
-- Issue #947 (TEAM-F05) — the obligation trigger's phone arm, corrected.
--
-- ---------------------------------------------------------------------------
-- 1. What 0223's predicate missed
-- ---------------------------------------------------------------------------
-- 0223 records the debt in the membership's own transaction. Its staleness
-- predicate is deliberately derivable from the columns the database can see,
-- and one of its arms was wrong:
--
--     (NEW.phone_e164 IS NOT NULL AND file_phone IS DISTINCT FROM NEW.phone_e164)
--
-- Every case where the membership *has* a number is covered. The case where the
-- membership's number is **cleared** is not: with `NEW.phone_e164 IS NULL` the
-- first conjunct fails whatever the file holds, so a membership whose phone went
-- from a number to NULL — while the linked file still carries the old number —
-- records nothing. A process that dies between that membership COMMIT and
-- `ensurePersonnelFileForMembership` therefore leaves a file holding a number
-- the member no longer has, with no row asking for the repair and no retry that
-- knows to look. The 0223 backfill repeats the same predicate, so rows already
-- in that state are missed too.
--
-- The application's rule has no such gap, and it is the rule this arm has to
-- follow. `personnelFileIsStale` compares the two *canonical* identities and
-- treats a cleared membership phone as canonical — `phone: member.phone_e164 ?
-- phoneE164(member.phone_e164) : null` — while the projection writes it through
-- (`patch.phone = identity.phone`), which clears the file's number. Email keeps
-- the opposite rule on purpose: «the membership has none» is not an instruction
-- to clear a file's email, which is why only the phone arm changes here.
--
-- ---------------------------------------------------------------------------
-- 2. Why a new migration instead of an edit
-- ---------------------------------------------------------------------------
-- 0223 is already applied wherever this branch has run (CI, and any database
-- that took the migration), and this repository's rule is that an applied
-- migration is never edited: the file is a record of what ran, not a draft. So
-- the correction is forward-only — the function is replaced, and the inventory
-- is re-run with the corrected predicate. Both are idempotent, and the re-run
-- leaves existing open episodes alone exactly as 0223's did.
--
-- ---------------------------------------------------------------------------
-- 3. What is *not* changed
-- ---------------------------------------------------------------------------
-- The name and email arms, the `attempts >= 0` contract, the partial unique
-- index, the «existing episode keeps its diagnosis» rule and the trigger's
-- attachment all stay as 0223 wrote them. The predicate is still allowed to be
-- conservative in *flagging* — it compares stored spellings, so a legacy row
-- whose number is a non-canonical spelling of the same number may be flagged
-- once; the service clears the false alarm on its next successful run, and
-- nothing here can be the reason a hire fails.

-- ---------------------------------------------------------------------------
-- 4. The corrected trigger function
-- ---------------------------------------------------------------------------
-- `CREATE OR REPLACE` keeps the trigger's binding: `trg_users_personnel_file_obligation`
-- calls this function by name, so replacing the body is the whole change.
CREATE OR REPLACE FUNCTION personnel_file_obligation() RETURNS trigger AS $$
DECLARE
    file_id    uuid;
    file_name  text;
    file_phone text;
    file_email text;
BEGIN
    SELECT p.id, p.name, p.phone_e164, p.email::text
      INTO file_id, file_name, file_phone, file_email
      FROM parties p
     WHERE p.business_id = NEW.business_id
       AND p.employee_user_id = NEW.id;

    IF file_id IS NULL THEN
        INSERT INTO personnel_file_drift (business_id, user_id, reason, last_error, attempts)
        VALUES (NEW.business_id, NEW.id, 'file_missing', 'awaiting_projection', 0)
        ON CONFLICT (business_id, user_id) WHERE resolved_at IS NULL DO NOTHING;
    ELSIF btrim(file_name) IS DISTINCT FROM btrim(NEW.full_name)
       -- The phone arm, in both directions (see §1). A membership phone that is
       -- absent — NULL or blank — while the file holds a number is a mismatch, not
       -- a silence; the file must be cleared like the membership was.
       OR (COALESCE(btrim(NEW.phone_e164), '') = '' AND COALESCE(btrim(file_phone), '') <> '')
       OR (COALESCE(btrim(NEW.phone_e164), '') <> '' AND file_phone IS DISTINCT FROM NEW.phone_e164)
       OR (NEW.email IS NOT NULL AND lower(file_email) IS DISTINCT FROM lower(NEW.email::text)) THEN
        INSERT INTO personnel_file_drift (business_id, user_id, reason, last_error, attempts)
        VALUES (NEW.business_id, NEW.id, 'identity_stale', 'awaiting_projection', 0)
        ON CONFLICT (business_id, user_id) WHERE resolved_at IS NULL DO NOTHING;
    END IF;

    RETURN NULL; -- AFTER trigger: the row is the database's now, not ours to change.
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION personnel_file_obligation() IS
    'Issue #947 (TEAM-F05; phone arm corrected in 0226). Records the personnel-file debt in the membership''s own transaction (reason file_missing or identity_stale, attempts 0). The service clears it; the trigger never does.';

-- ---------------------------------------------------------------------------
-- 5. The memberships already in that state
-- ---------------------------------------------------------------------------
-- The 0223 inventory re-run with the corrected predicate: a member whose phone was
-- cleared while their file kept the old number now receives the obligation they would
-- have received had 0223 got the arm right. Same rules as before — it only records,
-- existing open episodes keep their attempt count and diagnosis, and
-- `npm run personnel:reconcile` (or the next Team visit) fulfils what it records.
INSERT INTO personnel_file_drift (business_id, user_id, reason, last_error, attempts)
SELECT u.business_id,
       u.id,
       CASE WHEN p.id IS NULL THEN 'file_missing' ELSE 'identity_stale' END,
       'awaiting_projection',
       0
  FROM users u
  LEFT JOIN parties p
         ON p.business_id = u.business_id
        AND p.employee_user_id = u.id
 WHERE p.id IS NULL
    OR btrim(p.name) IS DISTINCT FROM btrim(u.full_name)
    OR (COALESCE(btrim(u.phone_e164), '') = '' AND COALESCE(btrim(p.phone_e164), '') <> '')
    OR (COALESCE(btrim(u.phone_e164), '') <> '' AND p.phone_e164 IS DISTINCT FROM u.phone_e164)
    OR (u.email IS NOT NULL AND lower(p.email::text) IS DISTINCT FROM lower(u.email::text))
ON CONFLICT (business_id, user_id) WHERE resolved_at IS NULL DO NOTHING;
