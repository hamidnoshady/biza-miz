-- Issue #972 — staff assignment actor may be deleted without deleting the
-- assignment.
--
-- 0301/0302 declared `assigned_by uuid NOT NULL REFERENCES users(id) ON DELETE
-- SET NULL`, which is self-contradictory: deleting the manager who made an
-- assignment would try to null a NOT NULL column and fail. The assignment is a
-- historical fact ("this member was assigned this learning item") and must
-- survive the assigner leaving the team; the column is now nullable, which is
-- what the FK action already intended.

ALTER TABLE tour_assignments ALTER COLUMN assigned_by DROP NOT NULL;
ALTER TABLE learning_path_assignments ALTER COLUMN assigned_by DROP NOT NULL;
