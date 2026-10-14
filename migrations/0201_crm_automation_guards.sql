-- The guards automations gained after 0200 had shipped in this branch: who
-- wrote a rule, and what may be stored about a run.
--
-- ## Why this is a second migration rather than an edit to 0200
--
-- Migrations are forward-only and immutable once a database has run them
-- (`scripts/migrate.ts`): a checksum mismatch aborts the whole run, because the
-- file a database executed is not the file in the image. 0200 was applied by
-- this branch's own environments before the gaps below were noticed, so the fix
-- arrives the way every other schema fix does — in front of it, idempotently,
-- so the databases that ran 0200 and the ones that have not both converge on
-- the same schema. `0199_crm_owner_ids.sql` was the same kind of follow-up.
--
-- ## What was missing
--
-- 1. **Identity for the author.** `created_by` is a display name; every other
--    CRM table keeps the id beside it (`crm-deals.created_by_id`,
--    `crm_activities.created_by_id`) so that a rename does not orphan the
--    decision. `saveAutomation` writes both.
-- 2. **Two storage-level refusals.** A rule whose name is blank cannot be
--    recognised in its own run log, and a run whose outcome is outside the
--    engine's four outcomes is a bug rather than a fact. The *composition* of a
--    rule (which triggers and actions exist) stays in code, where refusing what
--    the product does not implement is the point; these two are checks about
--    storage hygiene, so they belong to the table.
--
-- No RLS change: no table is added, and `crm_automations`/`crm_automation_runs`
-- already carry their policies from 0200.

ALTER TABLE crm_automations
    ADD COLUMN IF NOT EXISTS created_by_id uuid;

-- The same pair every other CRM table keeps: the name as a snapshot, the id as
-- identity. Nullable on purpose — a rule may be written by a process, and an
-- older row has no id to recover.
COMMENT ON COLUMN crm_automations.created_by_id IS
    'The member who wrote the rule; NULL when the author is a process or predates 0201.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'crm_automations_name_not_blank'
    ) THEN
        ALTER TABLE crm_automations
            ADD CONSTRAINT crm_automations_name_not_blank CHECK (btrim(name) <> '');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'crm_automation_runs_outcome_valid'
    ) THEN
        ALTER TABLE crm_automation_runs
            ADD CONSTRAINT crm_automation_runs_outcome_valid
            CHECK (outcome IN ('applied', 'skipped', 'failed', 'triggered_growth'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'crm_automation_runs_name_not_blank'
    ) THEN
        ALTER TABLE crm_automation_runs
            ADD CONSTRAINT crm_automation_runs_name_not_blank CHECK (btrim(automation_name) <> '');
    END IF;
END $$;
