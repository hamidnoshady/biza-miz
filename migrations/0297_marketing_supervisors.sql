-- Issue #900: organizational reporting links, not an authorization hierarchy.
-- The composite FK prevents references across tenants or internal branches.
ALTER TABLE marketing_agents ADD COLUMN supervisor_agent_id uuid;
ALTER TABLE marketing_agents ADD CONSTRAINT marketing_agents_supervisor_scope_fk
  FOREIGN KEY (business_id, location_id, supervisor_agent_id)
  REFERENCES marketing_agents (business_id, location_id, id);
ALTER TABLE marketing_agents ADD CONSTRAINT marketing_agents_not_own_supervisor
  CHECK (supervisor_agent_id IS NULL OR supervisor_agent_id <> id);
CREATE INDEX marketing_agents_supervisor_children
  ON marketing_agents (business_id, location_id, supervisor_agent_id)
  WHERE supervisor_agent_id IS NOT NULL;
