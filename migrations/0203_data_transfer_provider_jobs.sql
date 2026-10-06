-- First-class provider migrations share Data Transfer's generic import-job history.
-- The domain-specific run (e.g. holoo_import_runs) remains responsible for
-- idempotency and rollback; this metadata keeps the universal history readable.
ALTER TABLE data_import_jobs
    ADD COLUMN provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE data_export_jobs
    ADD COLUMN provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE data_export_jobs
    DROP CONSTRAINT IF EXISTS data_export_jobs_format_check;

ALTER TABLE data_export_jobs
    ADD CONSTRAINT data_export_jobs_format_check
    CHECK (format IN ('csv', 'xlsx', 'pdf', 'json', 'provider'));

ALTER TABLE data_import_jobs
    DROP CONSTRAINT IF EXISTS data_import_jobs_file_format_check;

ALTER TABLE data_import_jobs
    ADD CONSTRAINT data_import_jobs_file_format_check
    CHECK (file_format IN ('csv', 'xlsx', 'json', 'pdf', 'provider'));
