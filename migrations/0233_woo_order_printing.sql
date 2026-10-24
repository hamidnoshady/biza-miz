-- #935: shared templates/rules, with independent Woo documents and per-store routing.
ALTER TABLE print_templates DROP CONSTRAINT IF EXISTS print_templates_doc_type_check;
ALTER TABLE print_templates ADD CONSTRAINT print_templates_doc_type_check
  CHECK (doc_type IN ('receipt','invoice','kitchen','label','shipping_label','woo_invoice'));
ALTER TABLE print_rules DROP CONSTRAINT IF EXISTS print_rules_document_type_check;
ALTER TABLE print_rules ADD CONSTRAINT print_rules_document_type_check
  CHECK (document_type IN ('receipt','invoice','kitchen','label','shipping_label','woo_invoice'));
ALTER TABLE print_rules ADD COLUMN connection_id uuid REFERENCES integration_connections(id) ON DELETE CASCADE;
ALTER TABLE print_rules ADD CONSTRAINT print_rules_woo_store_only
  CHECK (connection_id IS NULL OR document_type IN ('shipping_label','woo_invoice'));
ALTER TABLE print_rules DROP CONSTRAINT IF EXISTS print_rules_location_id_document_type_key;
CREATE UNIQUE INDEX idx_print_rules_branch_document ON print_rules(location_id, document_type) WHERE connection_id IS NULL;
CREATE UNIQUE INDEX idx_print_rules_store_document ON print_rules(location_id, document_type, connection_id) WHERE connection_id IS NOT NULL;
-- The existing location RLS remains in force. Also constrain the optional store
-- to this tenant and branch, including when a direct SQL client writes a rule.
DROP POLICY tenant_isolation ON print_rules;
CREATE POLICY tenant_isolation ON print_rules FOR ALL
  USING (app_rls_bypass() OR (app_owns_location(location_id) AND (connection_id IS NULL OR EXISTS (
    SELECT 1 FROM integration_connections c WHERE c.id = connection_id AND c.location_id = print_rules.location_id
      AND c.business_id = app_current_business() AND c.provider = 'woocommerce'
  ))))
  WITH CHECK (app_rls_bypass() OR (app_owns_location(location_id) AND (connection_id IS NULL OR EXISTS (
    SELECT 1 FROM integration_connections c WHERE c.id = connection_id AND c.location_id = print_rules.location_id
      AND c.business_id = app_current_business() AND c.provider = 'woocommerce'
  ))));
-- Identifiers/provenance only. Recipient data in Woo render_snapshot jobs is
-- authenticated ciphertext, never general-purpose history or application logs.
ALTER TABLE print_jobs
  ADD COLUMN initiated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN connection_id uuid REFERENCES integration_connections(id) ON DELETE SET NULL,
  ADD COLUMN source_revision uuid,
  ADD COLUMN document_ref text;
CREATE INDEX idx_print_jobs_woo_order ON print_jobs(location_id, connection_id, document_ref, created_at DESC)
  WHERE connection_id IS NOT NULL;
-- Duplicate live requests with the same correlation id cannot hand off twice;
-- completed attempts and intentional reprints keep the existing history model.
CREATE UNIQUE INDEX idx_print_jobs_woo_live_request ON print_jobs(location_id, print_request_id)
  WHERE connection_id IS NOT NULL AND print_request_id IS NOT NULL
    AND previous_job_id IS NULL AND status IN ('created','preparing','routing','sending');
