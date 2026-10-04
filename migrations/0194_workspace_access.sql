-- Workspace Next (#761), Phase A — one access model for «میز کار من».
--
-- 1. Every project owner is a workspace member, always.
--
--    Project visibility is now decided by `workspace_members` alone (plus an
--    explicit business-wide override — see `workspaceAccessFlags` in
--    src/lib/workspace-shared.ts). Before this, three write paths created
--    `ai_projects` rows — the workspace service, the legacy assistant path in
--    ai-projects.ts and the data-transfer importer — and only the first wrote
--    the owner's member row, so `projectRoleFor` carried an "implicit owner"
--    fallback. That fallback opened the project page while «پروژه‌های من»
--    (which reads member rows) missed the same project. A trigger is the one
--    place all three paths, and any future one, have to pass through.
--
--    It also makes owner transfer atomic: changing `owner_user_id` promotes
--    the new owner to `owner` and demotes the previous one to `manager` in
--    the same statement, so the displayed owner and the access row can no
--    longer disagree.

CREATE OR REPLACE FUNCTION workspace_sync_project_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    new_owner uuid;
    old_owner uuid;
BEGIN
    new_owner := COALESCE(
        NEW.owner_user_id,
        CASE WHEN NEW.created_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN NEW.created_by::uuid END
    );

    IF new_owner IS NOT NULL
       AND EXISTS (SELECT 1 FROM users u WHERE u.id = new_owner AND u.business_id = NEW.business_id)
    THEN
        INSERT INTO workspace_members (project_id, user_id, role, added_by)
        VALUES (NEW.id, new_owner, 'owner', 'system')
        ON CONFLICT (project_id, user_id) DO UPDATE
           SET role = 'owner', updated_at = now();
    END IF;

    -- The previous EFFECTIVE owner: `owner_user_id`, or — for a project that
    -- never had one — the same `created_by` fallback the backfill used, so the
    -- first transfer of such a project demotes its creator too.
    IF TG_OP = 'UPDATE' AND OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
        old_owner := COALESCE(
            OLD.owner_user_id,
            CASE WHEN OLD.created_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 THEN OLD.created_by::uuid END
        );
        IF old_owner IS NOT NULL AND old_owner IS DISTINCT FROM new_owner THEN
            UPDATE workspace_members
               SET role = 'manager', updated_at = now()
             WHERE project_id = NEW.id AND user_id = old_owner AND role = 'owner';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_sync_project_owner ON ai_projects;
CREATE TRIGGER trg_workspace_sync_project_owner
    AFTER INSERT OR UPDATE OF owner_user_id ON ai_projects
    FOR EACH ROW EXECUTE FUNCTION workspace_sync_project_owner();

-- Backfill the projects the legacy paths created since 0167.
INSERT INTO workspace_members (project_id, user_id, role, added_by)
SELECT p.id, o.owner_id, 'owner', 'system'
  FROM ai_projects p
 CROSS JOIN LATERAL (
       SELECT COALESCE(
                p.owner_user_id,
                CASE WHEN p.created_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     THEN p.created_by::uuid END) AS owner_id
       ) o
 WHERE o.owner_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = o.owner_id AND u.business_id = p.business_id)
ON CONFLICT (project_id, user_id) DO UPDATE
   SET role = 'owner', updated_at = now()
 WHERE workspace_members.role <> 'owner';

-- 2. «درخواست اصلاح» — a third decision beside approve and reject. It sends
--    the subject back to its author (contract → draft, document → draft)
--    without the finality of a rejection.
ALTER TABLE workspace_approvals DROP CONSTRAINT IF EXISTS workspace_approvals_status_check;
ALTER TABLE workspace_approvals
    ADD CONSTRAINT workspace_approvals_status_check
        CHECK (status IN ('pending', 'approved', 'rejected', 'changes_requested', 'cancelled'));

-- 3. Date intervals the service already refuses, now also refused by the
--    database, so an import or a future write path cannot store them.
--    NOT VALID: existing rows are left alone rather than failing the deploy;
--    every new or updated row is checked.
ALTER TABLE ai_projects
    ADD CONSTRAINT ai_projects_dates_ordered
        CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date) NOT VALID;
ALTER TABLE workspace_project_phases
    ADD CONSTRAINT workspace_phases_dates_ordered
        CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date) NOT VALID;
ALTER TABLE workspace_contracts
    ADD CONSTRAINT workspace_contracts_dates_ordered
        CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date) NOT VALID;
ALTER TABLE workspace_events
    ADD CONSTRAINT workspace_events_times_ordered
        CHECK (start_time IS NULL OR end_time IS NULL OR end_time >= start_time) NOT VALID;
