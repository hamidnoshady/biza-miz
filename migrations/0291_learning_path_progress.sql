-- ============================================================================
-- 0291_learning_path_progress.sql — issue #972, item 3 (learning paths).
--
-- What one member has COMPLETED of one learning path. Learning path progress
-- is kept apart from tour progress (`tour_member_progress`) and from business
-- setup (`setup.progress`): finishing a path says the member has learned
-- something, not that the business is configured.
--
-- One row per (business, member, path). `path_id` is plain text, not a foreign
-- key — the path catalogue lives in code (`src/lib/learning-paths.ts`).
-- `path_version` records the revision the member last completed steps of;
-- the application keeps every completed step whose id still exists.
--
-- Tenant data: RLS is forced and keyed on `business_id`, and the row is
-- removed with its business or its user.
-- ============================================================================

CREATE TABLE IF NOT EXISTS learning_path_progress (
  business_id     uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path_id         text        NOT NULL,
  path_version    integer     NOT NULL,
  completed_step_ids text[]   NOT NULL DEFAULT '{}',
  current_step_id text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (business_id, user_id, path_id),
  CONSTRAINT learning_path_progress_path_id_shape
    CHECK (path_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT learning_path_progress_version_positive CHECK (path_version > 0),
  CONSTRAINT learning_path_progress_completed_bounded
    CHECK (cardinality(completed_step_ids) <= 60),
  CONSTRAINT learning_path_progress_current_shape
    CHECK (current_step_id IS NULL OR current_step_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
);

CREATE INDEX IF NOT EXISTS learning_path_progress_user
  ON learning_path_progress (business_id, user_id, last_active_at DESC);

ALTER TABLE learning_path_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_path_progress FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON learning_path_progress;
CREATE POLICY tenant_isolation ON learning_path_progress FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
