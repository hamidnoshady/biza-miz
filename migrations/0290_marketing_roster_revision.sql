-- Issue #900: optimistic concurrency for roster lifecycle changes.
ALTER TABLE marketing_agents ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0);
CREATE INDEX marketing_assignments_open_agent ON marketing_assignments (business_id, agent_id)
  WHERE status IN ('planned', 'in_progress');
