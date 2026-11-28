-- GH #1567 Phase 6A — tailoring / alterations.
--
-- Reuses what exists: the customer is a CRM `parties` row, the sale is an
-- ordinary `orders` row (a job links to it; there is no parallel invoice),
-- measurement values are encrypted with the business DEK (field-crypto,
-- POSFLD1 / AES-256-GCM) by the service layer, and every table carries the
-- standard tenant RLS policy.
--
-- Privacy rules encoded here (and asserted by integration/tailoring.integration.test.ts):
--   * measurements are versioned — a new version supersedes, nothing is
--     overwritten — and stored only as ciphertext (`measurements_enc`); there
--     is no plaintext measurement column, no free-text note and no photo /
--     image / media column anywhere in the module;
--   * erasure and retention purge null the ciphertext and stamp `erased_at`;
--     the row (version number, dates) stays so the history is honest;
--   * every access is written to an append-only log that cannot be updated
--     or deleted.

CREATE TABLE IF NOT EXISTS tailoring_settings (
    business_id               uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE RESTRICT,
    measurement_retention_days integer NOT NULL DEFAULT 730
                               CHECK (measurement_retention_days BETWEEN 30 AND 3650),
    updated_by                uuid NULL,
    updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tailoring_measurement_profiles (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    party_id         uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    version          integer NOT NULL CHECK (version > 0),
    unit             text NOT NULL CHECK (unit IN ('cm', 'in')),
    field_count      smallint NOT NULL CHECK (field_count BETWEEN 1 AND 40),
    measurements_enc bytea NULL,
    recorded_by      uuid NULL,
    recorded_at      timestamptz NOT NULL DEFAULT now(),
    superseded_at    timestamptz NULL,
    erased_at        timestamptz NULL,
    erased_reason    text NULL CHECK (erased_reason IS NULL OR length(erased_reason) BETWEEN 1 AND 500),
    UNIQUE (business_id, party_id, version),
    -- Exactly one of: readable ciphertext, or an erasure stamp.
    CHECK ((measurements_enc IS NULL) = (erased_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS tailoring_measurement_profiles_party_idx
    ON tailoring_measurement_profiles (business_id, party_id, version DESC);

CREATE TABLE IF NOT EXISTS tailoring_measurement_access_log (
    id            bigserial PRIMARY KEY,
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    party_id      uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    profile_id    uuid NULL REFERENCES tailoring_measurement_profiles(id) ON DELETE RESTRICT,
    actor_user_id uuid NULL,
    actor_name    text NOT NULL CHECK (length(actor_name) BETWEEN 1 AND 200),
    action        text NOT NULL CHECK (action IN ('record', 'view', 'export', 'erase', 'purge')),
    purpose       text NULL CHECK (purpose IS NULL OR length(purpose) BETWEEN 1 AND 300),
    at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tailoring_measurement_access_log_party_idx
    ON tailoring_measurement_access_log (business_id, party_id, at DESC);

CREATE OR REPLACE FUNCTION reject_tailoring_access_log_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tailoring measurement access log is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_tailoring_access_log_append_only ON tailoring_measurement_access_log;
CREATE TRIGGER trg_tailoring_access_log_append_only
  BEFORE UPDATE OR DELETE ON tailoring_measurement_access_log
  FOR EACH ROW EXECUTE FUNCTION reject_tailoring_access_log_mutation();

CREATE TABLE IF NOT EXISTS tailoring_jobs (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id            uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    party_id               uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    measurement_profile_id uuid NULL REFERENCES tailoring_measurement_profiles(id) ON DELETE RESTRICT,
    kind                   text NOT NULL CHECK (kind IN ('alteration', 'made_to_measure')),
    description            text NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
    status                 text NOT NULL DEFAULT 'intake'
                           CHECK (status IN ('intake', 'estimated', 'approved', 'fitting', 'qc', 'ready', 'picked_up', 'cancelled')),
    estimate_rial          bigint NULL CHECK (estimate_rial IS NULL OR estimate_rial >= 0),
    approved_at            timestamptz NULL,
    approved_by            uuid NULL,
    due_date               date NULL,
    order_id               uuid NULL REFERENCES orders(id) ON DELETE RESTRICT,
    fitting_count          smallint NOT NULL DEFAULT 0 CHECK (fitting_count >= 0),
    rework_count           smallint NOT NULL DEFAULT 0 CHECK (rework_count >= 0),
    version                integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by             uuid NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CHECK (status NOT IN ('approved', 'fitting', 'qc', 'ready', 'picked_up') OR (estimate_rial IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS tailoring_jobs_location_status_idx ON tailoring_jobs (location_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS tailoring_jobs_party_idx ON tailoring_jobs (business_id, party_id);
CREATE UNIQUE INDEX IF NOT EXISTS tailoring_jobs_order_uidx ON tailoring_jobs (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tailoring_job_events (
    id            bigserial PRIMARY KEY,
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    job_id        uuid NOT NULL REFERENCES tailoring_jobs(id) ON DELETE RESTRICT,
    from_status   text NULL,
    to_status     text NOT NULL,
    actor_user_id uuid NULL,
    actor_name    text NOT NULL CHECK (length(actor_name) BETWEEN 1 AND 200),
    note          text NULL CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
    at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tailoring_job_events_job_idx ON tailoring_job_events (job_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tailoring_settings', 'tailoring_measurement_profiles', 'tailoring_measurement_access_log',
                           'tailoring_jobs', 'tailoring_job_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL
                      USING (app_rls_bypass() OR business_id = app_current_business())
                      WITH CHECK (app_rls_bypass() OR business_id = app_current_business())', t);
  END LOOP;
END $$;
