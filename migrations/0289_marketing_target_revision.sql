-- Issue #900: optimistic concurrency for operational target edits and archival.
ALTER TABLE marketing_targets ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0);
