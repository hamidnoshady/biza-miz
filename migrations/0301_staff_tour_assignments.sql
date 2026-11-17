-- ============================================================================
-- 0301_staff_tour_assignments.sql — issue #972, item 9 (staff assignments).
--
-- A manager assigns a specific tour to a specific staff member so that
-- member's learning dashboard surfaces it as an assigned lesson. Assignment
-- is tracked apart from progress (`tour_member_progress`): being assigned a
-- tour says nothing about whether the member has started or completed it, and
-- completing a tour does not consume the assignment.
--
-- One row per (business, member, tour). `assigned_by` is the member who made
-- the assignment (for the audit trail); it is not a foreign key because the
-- assigner may have left the business by the time anyone asks.
--
-- Tenant data: RLS is forced and keyed on `business_id`, and the row is
-- removed with its business or its user.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tour_assignments (
  business_id   uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tour_id       text        NOT NULL,
  assigned_by   uuid        NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id, tour_id),
  CONSTRAINT tour_assignments_tour_id_shape
    CHECK (tour_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
);

CREATE INDEX IF NOT EXISTS tour_assignments_user
  ON tour_assignments (business_id, user_id, assigned_at DESC);

CREATE INDEX IF NOT EXISTS tour_assignments_tour
  ON tour_assignments (business_id, tour_id, assigned_at DESC);

ALTER TABLE tour_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tour_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tour_assignments;
CREATE POLICY tenant_isolation ON tour_assignments FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
