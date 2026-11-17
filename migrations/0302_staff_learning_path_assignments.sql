-- ============================================================================
-- 0302_staff_learning_path_assignments.sql — issue #972, item 9 (staff assignments).
--
-- A manager assigns a specific learning path to a specific staff member so
-- that member's learning dashboard surfaces it as an assigned lesson.
-- Assignment is tracked apart from progress (`learning_path_progress`):
-- being assigned a path says nothing about whether the member has started or
-- completed it, and completing a path does not consume the assignment.
--
-- One row per (business, member, path). `assigned_by` is the member who made
-- the assignment (for the audit trail); it is not a foreign key because the
-- assigner may have left the business by the time anyone asks.
--
-- Tenant data: RLS is forced and keyed on `business_id`, and the row is
-- removed with its business or its user.
-- ============================================================================

CREATE TABLE IF NOT EXISTS learning_path_assignments (
  business_id   uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path_id       text        NOT NULL,
  assigned_by   uuid        NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id, path_id),
  CONSTRAINT learning_path_assignments_path_id_shape
    CHECK (path_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
);

CREATE INDEX IF NOT EXISTS learning_path_assignments_user
  ON learning_path_assignments (business_id, user_id, assigned_at DESC);

CREATE INDEX IF NOT EXISTS learning_path_assignments_path
  ON learning_path_assignments (business_id, path_id, assigned_at DESC);

ALTER TABLE learning_path_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_path_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON learning_path_assignments;
CREATE POLICY tenant_isolation ON learning_path_assignments FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
