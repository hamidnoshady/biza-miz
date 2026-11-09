-- Issue #900: efficiently list one marketer's own branch-scoped assignments.
CREATE INDEX marketing_assignments_agent_queue
  ON marketing_assignments (business_id, agent_id, created_at DESC, id DESC);
