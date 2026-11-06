-- Issue #900: operational prospect sites and work assignments. The optional
-- party is the canonical CRM/Accounting party, not a copied contact record.
CREATE UNIQUE INDEX marketing_agents_business_branch_id_key ON marketing_agents (business_id, location_id, id);

CREATE TABLE marketing_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  party_id uuid,
  site_label text NOT NULL CHECK (char_length(trim(site_label)) BETWEEN 1 AND 150),
  city text NOT NULL DEFAULT '' CHECK (char_length(city) <= 100),
  neighborhood text NOT NULL DEFAULT '' CHECK (char_length(neighborhood) <= 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES locations(business_id, id),
  FOREIGN KEY (business_id, party_id) REFERENCES parties(business_id, id),
  UNIQUE (business_id, location_id, id)
);
CREATE INDEX marketing_targets_branch_list ON marketing_targets (business_id, location_id, created_at DESC, id);
CREATE INDEX marketing_targets_created_by ON marketing_targets (business_id, created_by) WHERE created_by IS NOT NULL;
CREATE INDEX marketing_targets_party ON marketing_targets (business_id, party_id) WHERE party_id IS NOT NULL;
ALTER TABLE marketing_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON marketing_targets FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE marketing_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  target_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 150),
  due_date date,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed', 'canceled')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES locations(business_id, id),
  FOREIGN KEY (business_id, location_id, target_id) REFERENCES marketing_targets(business_id, location_id, id),
  FOREIGN KEY (business_id, location_id, agent_id) REFERENCES marketing_agents(business_id, location_id, id),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX marketing_assignments_one_open ON marketing_assignments (business_id, target_id, agent_id) WHERE status IN ('planned', 'in_progress');
CREATE INDEX marketing_assignments_created_by ON marketing_assignments (business_id, created_by) WHERE created_by IS NOT NULL;
CREATE INDEX marketing_assignments_branch_list ON marketing_assignments (business_id, location_id, created_at DESC, id);
ALTER TABLE marketing_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON marketing_assignments FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
