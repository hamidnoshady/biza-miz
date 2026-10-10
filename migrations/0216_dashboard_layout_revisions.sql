-- Dashboard layout identity/revisions are independent from widget rows.
--
-- An empty personal layout is a real override, not "no layout": it stops
-- inheriting the role default. Each layout therefore keeps a durable state row
-- even when its dashboard_widgets row set is empty. Revisions are opaque
-- tokens advanced by every atomic replacement/append.

-- Make cross-tenant widget references impossible at the database boundary,
-- not only through the reports service's preflight. Existing mismatches are
-- treated as a migration blocker rather than silently re-homed or deleted.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM dashboard_widgets dw
      JOIN saved_reports sr ON sr.id = dw.saved_report_id
     WHERE dw.business_id <> sr.business_id
  ) THEN
    RAISE EXCEPTION 'dashboard_widgets contains a saved report from another business';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM dashboard_widgets dw
      JOIN users u ON u.id = dw.user_id
     WHERE dw.business_id <> u.business_id
  ) THEN
    RAISE EXCEPTION 'dashboard_widgets contains a user from another business';
  END IF;
END
$$;

ALTER TABLE saved_reports
  ADD CONSTRAINT saved_reports_business_id_id_layout_unique UNIQUE (business_id, id);

ALTER TABLE dashboard_widgets
  DROP CONSTRAINT IF EXISTS dashboard_widgets_saved_report_id_fkey,
  DROP CONSTRAINT IF EXISTS dashboard_widgets_user_id_fkey;

ALTER TABLE dashboard_widgets
  ADD CONSTRAINT dashboard_widgets_business_report_fk
    FOREIGN KEY (business_id, saved_report_id)
    REFERENCES saved_reports (business_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT dashboard_widgets_business_user_fk
    FOREIGN KEY (business_id, user_id)
    REFERENCES users (business_id, id) ON DELETE CASCADE;

CREATE TABLE dashboard_widget_layout_state (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid,
  role user_role,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_widget_layout_state_scope
    CHECK ((user_id IS NOT NULL) <> (role IS NOT NULL)),
  CONSTRAINT dashboard_widget_layout_state_business_user_fk
    FOREIGN KEY (business_id, user_id)
    REFERENCES users (business_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX dashboard_widget_layout_state_user_uq
  ON dashboard_widget_layout_state (business_id, user_id)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX dashboard_widget_layout_state_role_uq
  ON dashboard_widget_layout_state (business_id, role)
  WHERE role IS NOT NULL;

-- Preserve the layouts that already exist. The initial tokens are opaque and
-- no client can hold a pre-migration precondition, so a fresh GET safely starts
-- the new revision contract. The old table had no state row, so an empty
-- pre-migration personal row set cannot distinguish "never customized" from
-- "intentionally cleared"; migration policy treats it as uninitialized and
-- therefore inheriting. From this migration forward, a state row (even with no
-- widget rows) is the explicit personal-layout override.
INSERT INTO dashboard_widget_layout_state (business_id, user_id, role)
SELECT DISTINCT business_id, user_id, role
  FROM dashboard_widgets
ON CONFLICT DO NOTHING;

-- Layout state contains business data and is subject to the same fail-closed
-- RLS boundary as dashboard_widgets and saved_reports.
ALTER TABLE dashboard_widget_layout_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_widget_layout_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dashboard_widget_layout_state FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
