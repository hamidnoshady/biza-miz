-- 0299_import_reconciliation_extensions.sql — issue #1118 completion:
--
-- 1. Cutover authority/time boundary and field-authority policy snapshot on
--    reconciliation runs so migrations record who owns books vs inventory
--    from what instant.
-- 2. Rejected remote-edit fingerprints so an owner rejecting an incoming remote
--    field value (e.g. choosing canonical over source) suppresses endless
--    re-proposals and outbound echoes of that exact rejected value until the
--    remote value actually changes.
-- 3. Optional reconciliation_run_id on data_import_jobs so generic Data Transfer
--    file imports into populated domains link cleanly to their #1118 review run.

ALTER TABLE import_reconciliation_runs
    ADD COLUMN IF NOT EXISTS cutover_authority text
        CHECK (cutover_authority IS NULL OR cutover_authority IN ('books', 'source', 'two_way', 'archive_only')),
    ADD COLUMN IF NOT EXISTS cutover_at timestamptz,
    ADD COLUMN IF NOT EXISTS policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(policy_snapshot) = 'object');

CREATE TABLE import_reconciliation_rejected_edits (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    source_key       text NOT NULL CHECK (char_length(btrim(source_key)) BETWEEN 1 AND 200),
    domain           text NOT NULL CHECK (domain IN ('product', 'party', 'financial_document', 'inventory')),
    external_type    text NOT NULL CHECK (char_length(btrim(external_type)) BETWEEN 1 AND 80),
    external_id      text NOT NULL CHECK (char_length(btrim(external_id)) BETWEEN 1 AND 240),
    field            text NOT NULL CHECK (char_length(btrim(field)) BETWEEN 1 AND 120),
    fingerprint      text NOT NULL,
    reason           text NOT NULL DEFAULT '',
    rejected_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    rejected_by_name text NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, source_key, domain, external_type, external_id, field)
);

CREATE INDEX idx_reconciliation_rejected_edits_lookup
    ON import_reconciliation_rejected_edits (business_id, source_key, domain, external_type, external_id);

ALTER TABLE import_reconciliation_rejected_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_reconciliation_rejected_edits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_reconciliation_rejected_edits FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE data_import_jobs
    ADD COLUMN IF NOT EXISTS reconciliation_run_id uuid
        REFERENCES import_reconciliation_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_data_import_jobs_reconciliation_run
    ON data_import_jobs (reconciliation_run_id)
    WHERE reconciliation_run_id IS NOT NULL;
