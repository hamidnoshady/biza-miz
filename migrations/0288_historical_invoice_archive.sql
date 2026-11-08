-- Issue #1289: read-only evidence from a previous sales system. These tables
-- are deliberately unrelated to orders, payments, journals and stock. They do
-- not create receivables or enter any operational sales aggregate.
-- Customer identity continues to live in parties and source_identities.

ALTER TABLE users ADD CONSTRAINT users_id_business_historical_key UNIQUE (id, business_id);
ALTER TABLE parties ADD CONSTRAINT parties_id_business_historical_key UNIQUE (id, business_id);
ALTER TABLE data_import_jobs ADD CONSTRAINT data_import_jobs_id_business_historical_key UNIQUE (id, business_id);

CREATE TABLE historical_sales_invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid NOT NULL,
    party_id uuid NOT NULL,
    import_job_id uuid NOT NULL,
    source_key text NOT NULL CHECK (char_length(btrim(source_key)) BETWEEN 1 AND 200),
    source_provider text NOT NULL DEFAULT '' CHECK (char_length(source_provider) <= 200),
    external_id text NOT NULL CHECK (char_length(btrim(external_id)) BETWEEN 1 AND 300),
    invoice_number text NOT NULL DEFAULT '',
    invoice_date date NOT NULL,
    external_customer_code text NOT NULL CHECK (char_length(btrim(external_customer_code)) BETWEEN 1 AND 300),
    source_branch text NOT NULL DEFAULT '',
    source_currency text NOT NULL CHECK (source_currency IN ('rial', 'toman')),
    source_calendar text NOT NULL CHECK (source_calendar IN ('jalali', 'gregorian')),
    source_status text NOT NULL DEFAULT '',
    total_rial bigint NOT NULL CHECK (total_rial >= 0),
    paid_rial bigint CHECK (paid_rial >= 0),
    balance_rial bigint CHECK (balance_rial >= 0),
    summary_only boolean NOT NULL,
    source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
    -- The mapped source rows, not a substitute for the original uploaded file.
    source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'array'),
    created_by uuid,
    created_by_name text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, business_id),
    UNIQUE (business_id, source_key, external_id),
    FOREIGN KEY (created_by, business_id) REFERENCES users (id, business_id) ON DELETE RESTRICT,
    FOREIGN KEY (location_id, business_id) REFERENCES locations (id, business_id) ON DELETE RESTRICT,
    FOREIGN KEY (party_id, business_id) REFERENCES parties (id, business_id) ON DELETE RESTRICT,
    FOREIGN KEY (import_job_id, business_id) REFERENCES data_import_jobs (id, business_id) ON DELETE RESTRICT
);
CREATE INDEX idx_historical_sales_invoices_customer ON historical_sales_invoices (business_id, location_id, party_id, invoice_date DESC, id);
CREATE INDEX idx_historical_sales_invoices_date ON historical_sales_invoices (business_id, location_id, invoice_date DESC, id);

CREATE TABLE historical_sales_invoice_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    line_number integer NOT NULL CHECK (line_number > 0),
    -- The exact mapped source values are retained, including quantity and units.
    source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
    UNIQUE (invoice_id, line_number),
    FOREIGN KEY (invoice_id, business_id) REFERENCES historical_sales_invoices (id, business_id) ON DELETE CASCADE
);

-- Originals cannot be silently rewritten or re-pointed; corrections require a
-- separately designed auditable flow. Deletion remains possible for tenant
-- teardown through the normal cascades (no application delete path is exposed).
CREATE FUNCTION historical_sales_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'historical_sales_evidence_immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER historical_sales_invoice_immutable BEFORE UPDATE ON historical_sales_invoices
    FOR EACH ROW EXECUTE FUNCTION historical_sales_evidence_immutable();
CREATE TRIGGER historical_sales_invoice_line_immutable BEFORE UPDATE ON historical_sales_invoice_lines
    FOR EACH ROW EXECUTE FUNCTION historical_sales_evidence_immutable();

ALTER TABLE historical_sales_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE historical_sales_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON historical_sales_invoices FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
ALTER TABLE historical_sales_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE historical_sales_invoice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON historical_sales_invoice_lines FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
