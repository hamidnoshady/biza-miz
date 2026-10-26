-- ============================================================================
-- 0259_tour_member_progress.sql — issue #972 (interactive guided tours).
--
-- What one member has SEEN of one guided tour. Learning progress is kept
-- apart from business setup (`setup.progress`) on purpose: finishing a tour
-- says nothing about whether the business is configured, and the setup
-- wizard's completion marker must never be repurposed as "this person has
-- learned the product".
--
-- One row per (business, member, tour). The tour catalogue itself lives in
-- code (`src/lib/tours.ts`), so `tour_id` is plain text, not a foreign key,
-- and a tour retired from the code simply stops being read. `tour_version`
-- records the revision the member last saw; the application keeps every seen
-- step whose id still exists, so a revision only re-asks about what changed.
--
-- Tenant data: RLS is forced and keyed on `business_id` like every other
-- member-owned table, and the row is removed with its business or its user.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tour_member_progress (
  business_id     uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tour_id         text        NOT NULL,
  tour_version    integer     NOT NULL,
  seen_step_ids   text[]      NOT NULL DEFAULT '{}',
  current_step_id text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (business_id, user_id, tour_id),
  CONSTRAINT tour_member_progress_tour_id_shape
    CHECK (tour_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT tour_member_progress_version_positive CHECK (tour_version > 0),
  -- A definition may never outgrow what one row is allowed to hold.
  CONSTRAINT tour_member_progress_seen_bounded CHECK (cardinality(seen_step_ids) <= 60),
  CONSTRAINT tour_member_progress_current_shape
    CHECK (current_step_id IS NULL OR current_step_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
);

CREATE INDEX IF NOT EXISTS tour_member_progress_user
  ON tour_member_progress (business_id, user_id, last_active_at DESC);

ALTER TABLE tour_member_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE tour_member_progress FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tour_member_progress;
CREATE POLICY tenant_isolation ON tour_member_progress FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
