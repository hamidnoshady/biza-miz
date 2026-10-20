-- Issue #937 — preserve Woo customer identity tombstones and make imports
-- bounded, observable and resumable across request interruptions.

ALTER TABLE crm_external_profiles
    ADD COLUMN remote_deleted_at timestamptz;

CREATE INDEX idx_crm_external_profiles_remote_deleted
    ON crm_external_profiles (business_id, connection_id, remote_deleted_at)
    WHERE remote_deleted_at IS NOT NULL;

CREATE TABLE integration_customer_sync_runs (
    id             uuid PRIMARY KEY,
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id  uuid NOT NULL,
    transport      text NOT NULL CHECK (transport IN ('rest_api', 'plugin')),
    status         text NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'partial', 'completed', 'failed')),
    expected_count integer CHECK (expected_count IS NULL OR expected_count >= 0),
    current_page   integer NOT NULL DEFAULT 1 CHECK (current_page >= 1),
    total_pages    integer CHECK (total_pages IS NULL OR total_pages >= 0),
    started_at     timestamptz NOT NULL DEFAULT now(),
    completed_at   timestamptz,
    last_error     text,
    requested_by   text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, business_id),
    UNIQUE (id, connection_id, business_id),
    CONSTRAINT integration_customer_sync_runs_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_integration_customer_sync_runs_active
    ON integration_customer_sync_runs (business_id, connection_id, status, started_at DESC);

CREATE TABLE integration_customer_sync_run_items (
    run_id        uuid NOT NULL,
    business_id   uuid NOT NULL,
    connection_id uuid NOT NULL,
    remote_id     text NOT NULL,
    outcome       text NOT NULL
                  CHECK (outcome IN ('created', 'updated', 'linked', 'unresolved',
                                     'conflicted', 'skipped', 'failed')),
    error         text,
    attempts      integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, remote_id),
    CONSTRAINT integration_customer_sync_run_items_run_fk
        FOREIGN KEY (run_id, connection_id, business_id)
        REFERENCES integration_customer_sync_runs (id, connection_id, business_id)
        ON DELETE CASCADE,
    CONSTRAINT integration_customer_sync_run_items_connection_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_integration_customer_sync_run_items_outcome
    ON integration_customer_sync_run_items (run_id, outcome);

ALTER TABLE integration_customer_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_customer_sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_customer_sync_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE integration_customer_sync_run_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_customer_sync_run_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_customer_sync_run_items FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
