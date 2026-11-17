-- Existing and older clients' assignments start with normal priority.
ALTER TABLE marketing_assignments
  ADD COLUMN priority text NOT NULL DEFAULT 'normal'
  CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  ADD COLUMN priority_revision integer NOT NULL DEFAULT 0 CHECK (priority_revision >= 0);
