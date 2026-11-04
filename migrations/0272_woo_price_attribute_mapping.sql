-- Issue 951: explicit store pricing and reviewed local/remote identities.
ALTER TABLE integration_connections
  ADD COLUMN price_source text NOT NULL DEFAULT 'base' CHECK (price_source IN ('base', 'list')),
  ADD COLUMN price_list_id uuid REFERENCES price_lists(id) ON DELETE RESTRICT,
  ADD CONSTRAINT woo_price_source_shape CHECK ((price_source = 'list') = (price_list_id IS NOT NULL));

CREATE TABLE integration_woo_attribute_mappings (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  definition_id uuid NOT NULL REFERENCES item_attribute_definitions(id) ON DELETE CASCADE,
  remote_attribute_id integer NOT NULL CHECK (remote_attribute_id > 0),
  taxonomy text NOT NULL CHECK (taxonomy LIKE 'pa_%'),
  terms jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(terms) = 'object'),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, definition_id),
  UNIQUE (connection_id, remote_attribute_id),
  UNIQUE (connection_id, taxonomy),
  FOREIGN KEY (connection_id, business_id) REFERENCES integration_connections(id, business_id) ON DELETE CASCADE
);
ALTER TABLE integration_woo_attribute_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_woo_attribute_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_woo_attribute_mappings FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
