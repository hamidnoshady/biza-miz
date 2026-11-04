-- Issue #900: branch-scoped operational roster only. CRM identities, access,
-- compensation, targets and visit evidence are deliberately not created here.
CREATE UNIQUE INDEX IF NOT EXISTS locations_business_id_id_marketing_key ON locations (business_id, id);

CREATE TABLE marketing_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  user_id uuid REFERENCES users(id),
  display_name text NOT NULL CHECK (char_length(trim(display_name)) BETWEEN 1 AND 150),
  kind text NOT NULL CHECK (kind IN ('employee', 'contractor', 'affiliate', 'agency')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_agents_employee_user CHECK ((kind = 'employee') = (user_id IS NOT NULL)),
  FOREIGN KEY (business_id, location_id) REFERENCES locations(business_id, id),
  FOREIGN KEY (business_id, user_id) REFERENCES users(business_id, id),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX marketing_agents_one_employee ON marketing_agents (business_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX marketing_agents_created_by ON marketing_agents (business_id, created_by) WHERE created_by IS NOT NULL;
CREATE INDEX marketing_agents_branch_list ON marketing_agents (business_id, location_id, created_at DESC, id);
ALTER TABLE marketing_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON marketing_agents FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
