-- 0223_personnel_file_obligation.sql
--
-- Issue #947 (TEAM-F05) — the membership → personnel-file obligation, recorded in the
-- membership's *own* transaction.
--
-- ---------------------------------------------------------------------------
-- 1. What 0221 left open
-- ---------------------------------------------------------------------------
-- 0221 gave every membership writer one idempotent `ensurePersonnelFileForMembership`
-- and a table to record what it could not do (`personnel_file_drift`). Both halves
-- live in the application: the membership transaction commits, *then* the file is
-- written, and a failure is recorded afterwards by the same process. Two gaps follow
-- from that shape, and they are the ones this migration closes:
--
--   a. a process that dies between the membership COMMIT and the `INSERT INTO
--      personnel_file_drift` leaves a member with no file and no record of the debt.
--      «Durable retry» was only as durable as the second statement;
--
--   b. a writer nobody updated (a future screen, a restored dump, a repair script, a
--      replica's own apply) leaves the same hole *silently*, because the obligation is
--      a convention the writers are supposed to follow rather than a property of the
--      row they wrote.
--
-- ---------------------------------------------------------------------------
-- 2. The obligation is part of the membership write
-- ---------------------------------------------------------------------------
-- A trigger on `users` records the debt in the same transaction as the membership
-- itself: `AFTER INSERT` for a hire, and `AFTER UPDATE OF full_name, email,
-- phone_e164` for the three fields a file mirrors. Either the membership and its
-- obligation commit together, or neither does. There is no committed membership
-- without a file or a written-down reason why it does not have one yet.
--
-- Deliberately *not* done here:
--
--   * **The trigger does not create the file.** It cannot: a file is a `parties` row
--     with an accounting code, a DEK-encrypted phone and a canonical identity derived
--     by `createParty` — writing one in a trigger would be a second party writer next
--     to the canonical one, which is exactly the duplication this issue is about.
--     The obligation is what the trigger owns; the projection is what the service does.
--
--   * **The trigger does not resolve rows either.** Deciding «the file matches the
--     membership again» means normalizing the stored phone and applying the
--     email-direction rule, which lives in `personnel-file.ts` — the single authority
--     that already clears this table. Keeping one decider avoids two implementations
--     that disagree about, say, a legacy phone spelling. The sync clears; the trigger
--     only records.
--
--   * **It does not block a membership on a cheap-but-wrong check.** The staleness
--     predicate below answers «could the file be out of line» from the columns the
--     database can see. It is allowed to be conservative in *flagging* (the sync
--     clears a false alarm on its next run) and it must never be the reason a hire
--     fails: the only way it aborts a membership write is a genuine database error,
--     in which case the whole transaction rolls back with it — an explicit failure,
--     not a committed member whose file quietly never appears.
--
-- ---------------------------------------------------------------------------
-- 3. `attempts` may be zero
-- ---------------------------------------------------------------------------
-- A row written by the trigger records a debt nobody has tried to pay yet, and the
-- column has to be able to say that instead of claiming an attempt that never
-- happened. `recordPersonnelFileDrift` still counts real attempts from one upward:
-- the trigger's zero becomes one on the first failure.

ALTER TABLE personnel_file_drift
    DROP CONSTRAINT IF EXISTS personnel_file_drift_attempts_check;

ALTER TABLE personnel_file_drift
    ADD CONSTRAINT personnel_file_drift_attempts_check CHECK (attempts >= 0);

COMMENT ON COLUMN personnel_file_drift.attempts IS
    'Projection attempts that failed. 0 means the obligation is recorded but nothing has tried to fulfil it yet (migration 0223).';

-- ---------------------------------------------------------------------------
-- 4. The trigger
-- ---------------------------------------------------------------------------
-- `ON CONFLICT ... DO NOTHING` against the partial unique index: an episode already
-- open for this member (a real failure being retried) is not disturbed by a second
-- observation of the same debt. Nothing here overwrites `last_error` — the service's
-- diagnosis is more specific than the trigger's «owed».
CREATE FUNCTION personnel_file_obligation() RETURNS trigger AS $$
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
       OR (NEW.phone_e164 IS NOT NULL AND file_phone IS DISTINCT FROM NEW.phone_e164)
       OR (NEW.email IS NOT NULL AND lower(file_email) IS DISTINCT FROM lower(NEW.email::text)) THEN
        INSERT INTO personnel_file_drift (business_id, user_id, reason, last_error, attempts)
        VALUES (NEW.business_id, NEW.id, 'identity_stale', 'awaiting_projection', 0)
        ON CONFLICT (business_id, user_id) WHERE resolved_at IS NULL DO NOTHING;
    END IF;

    RETURN NULL; -- AFTER trigger: the row is the database's now, not ours to change.
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_personnel_file_obligation
    AFTER INSERT OR UPDATE OF full_name, email, phone_e164 ON users
    FOR EACH ROW EXECUTE FUNCTION personnel_file_obligation();

COMMENT ON FUNCTION personnel_file_obligation() IS
    'Issue #947 (TEAM-F05). Records the personnel-file debt in the membership''s own transaction (reason file_missing or identity_stale, attempts 0). The service clears it; the trigger never does.';

-- ---------------------------------------------------------------------------
-- 5. The memberships that already owe a file
-- ---------------------------------------------------------------------------
-- The same inventory, run once over what exists: members whose file is missing or
-- out of line get the obligation they would have received had they been written after
-- this migration. It is the same predicate as the trigger's, and like the trigger it
-- only records — `npm run personnel:reconcile` (or the next Team visit) fulfils them.
-- Existing open rows are left alone, so an episode already being retried keeps its
-- attempted count and its diagnosis.
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
    OR (u.phone_e164 IS NOT NULL AND p.phone_e164 IS DISTINCT FROM u.phone_e164)
    OR (u.email IS NOT NULL AND lower(p.email::text) IS DISTINCT FROM lower(u.email::text))
ON CONFLICT (business_id, user_id) WHERE resolved_at IS NULL DO NOTHING;

COMMENT ON TABLE personnel_file_drift IS
    'Issue #947 (TEAM-F05). One open row per membership whose personnel file is owed: written by the membership write itself (trigger, attempts 0) or by a failed projection, cleared when the file matches the membership again. `users` × `parties` is the independent inventory (see listPersonnelFileDebts).';
