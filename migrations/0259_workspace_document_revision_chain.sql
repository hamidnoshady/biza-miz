-- Issue #907 F15 — a document revision chain cannot fork.
--
-- `createDocument` gives a new revision its predecessor's `version + 1`, read
-- from the row being superseded. Two simultaneous revisions of v1 both read
-- `version = 1`, both write a v2, and the chain has two heads with the same
-- number; nothing in the schema noticed, because `supersedes_id` is an ordinary
-- foreign key.
--
-- The service now locks the predecessor row for the length of its transaction
-- (`SELECT … FOR UPDATE` in `createDocument`), which serializes the two writers.
-- A lock is only as strong as every writer's willingness to take it, though, so
-- the rule is also written where it cannot be skipped: one row may supersede
-- another **once**.
--
-- ## Why a trigger and not a unique index
--
-- A partial unique index on `supersedes_id` is the obvious shape, but it cannot
-- be created over data that already violates it, and the only ways to make
-- existing forks fit are to delete revision history or to detach a revision from
-- the version it revised — both forbidden by #907 ("do not … silently rewrite
-- history"). A `BEFORE INSERT` trigger refuses the *next* fork without touching
-- the ones already recorded, which is the same forward-only posture as 0258's
-- reconcile: history stays, the rule starts now.
--
-- The trigger locks the predecessor itself, so it is correct even for a writer
-- that never ran the service's own lock.
CREATE OR REPLACE FUNCTION workspace_document_single_successor() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    existing_id uuid;
BEGIN
    IF NEW.supersedes_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Serialize on the predecessor: a concurrent revision of the same version
    -- waits here rather than both passing the check below.
    PERFORM 1
       FROM workspace_documents
      WHERE id = NEW.supersedes_id
        FOR UPDATE;

    SELECT id INTO existing_id
      FROM workspace_documents
     WHERE supersedes_id = NEW.supersedes_id
     LIMIT 1;

    IF existing_id IS NOT NULL THEN
        -- 23505 with a named constraint: the service maps it to
        -- `document_already_superseded` exactly as it maps any unique violation
        -- it knows the meaning of, and a raw writer still gets a refusal that
        -- names the rule instead of a generic error.
        RAISE EXCEPTION 'workspace document % is already superseded by %',
            NEW.supersedes_id, existing_id
            USING ERRCODE = '23505',
                  CONSTRAINT = 'workspace_documents_one_successor';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_documents_one_successor ON workspace_documents;
CREATE TRIGGER workspace_documents_one_successor
    BEFORE INSERT ON workspace_documents
    FOR EACH ROW
    EXECUTE FUNCTION workspace_document_single_successor();

-- 0189/0258 precedent: the runner wraps each file in its own transaction, and a
-- function created here must be owned by the migrating role, which the runner
-- already is. No RLS bypass is needed: the trigger reads the same tenant's rows
-- that the inserting statement is subject to.
