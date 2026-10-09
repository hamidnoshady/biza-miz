-- Issue #866 — taxpayer e-invoicing (سامانه مودیان): settings, the immutable
-- submission record, and its append-only history.
--
-- Accounting boundary: nothing in this migration posts to the ledger. A
-- submission *references* the sale that is already posted (`order_id`) and
-- carries a copy of that document's totals as they stood when it was prepared.
-- Those copied columns exist so reconciliation can tie a taxpayer record to its
-- internal document; they are never a second revenue or VAT ledger.
--
-- Three rules are enforced here, not only in the service, because they are the
-- ones a bug would turn into a duplicate or a rewritten tax record:
--   * a submission's identity and payload never change after it is prepared;
--   * its status moves only along the transitions in
--     `tax_status_transition_allowed` (mirrored from src/lib/tax-invoice.ts);
--   * its history is append-only, and a submission is never deleted.

-- 1. The business's taxpayer profile (one row per business) -------------------
CREATE TABLE tax_invoice_profiles (
    business_id            uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    enabled                boolean NOT NULL DEFAULT false,
    environment            text NOT NULL DEFAULT 'sandbox'
                           CHECK (environment IN ('sandbox', 'production')),
    submission_mode        text NOT NULL DEFAULT 'direct'
                           CHECK (submission_mode IN ('direct', 'tsp')),
    taxpayer_id            text CHECK (taxpayer_id IS NULL OR char_length(taxpayer_id) BETWEEN 1 AND 32),
    taxpayer_name          text CHECK (taxpayer_name IS NULL OR char_length(taxpayer_name) BETWEEN 1 AND 200),
    -- Prefix on every reference number this business issues. Letters and digits
    -- only: the reference number is sent to the authority verbatim.
    reference_prefix       text NOT NULL DEFAULT ''
                           CHECK (reference_prefix ~ '^[A-Za-z0-9]{0,8}$'),
    -- Provider credentials as one AES-256-GCM blob (src/lib/integrations/secrets.ts).
    -- No read path returns it; the API reports only whether one is present.
    credentials_ciphertext text,
    updated_at             timestamptz NOT NULL DEFAULT now(),
    updated_by             uuid REFERENCES users(id) ON DELETE SET NULL
);

-- 2. The tax memory and unit identifiers of each branch -----------------------
CREATE TABLE tax_invoice_units (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    -- «شناسه یکتای حافظه مالیاتی» — the tax memory the branch's invoices go through.
    memory_id   text NOT NULL CHECK (char_length(trim(memory_id)) BETWEEN 1 AND 64),
    unit_code   text CHECK (unit_code IS NULL OR char_length(unit_code) BETWEEN 1 AND 32),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, location_id)
);

-- 3. The tax item code («شناسه کالا/خدمت») of each product that is sold ------
-- Polymorphic on purpose: a sold line points at either a restaurant menu item
-- or a retail item, and both models share this one code table.
CREATE TABLE tax_item_codes (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    product_kind text NOT NULL CHECK (product_kind IN ('menu_item', 'item')),
    product_id   uuid NOT NULL,
    code         text NOT NULL CHECK (code ~ '^[0-9]{13}$'),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, product_kind, product_id)
);

-- 4. Submissions — one row per taxpayer invoice, never rewritten ---------------
CREATE TABLE tax_invoice_submissions (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id          uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id          uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    -- The internal source document: the completed sale this record reports.
    order_id             uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    kind                 text NOT NULL CHECK (kind IN ('sale', 'amendment', 'cancellation')),
    -- Nth record of this kind for this order: a resubmission after a rejection,
    -- or a second correction, is a new revision and never reuses a number.
    revision             integer NOT NULL CHECK (revision >= 1),
    -- The accepted record an amendment or cancellation corrects.
    parent_submission_id uuid REFERENCES tax_invoice_submissions(id) ON DELETE RESTRICT,
    CHECK ((kind = 'sale') = (parent_submission_id IS NULL)),
    -- Derived from (business, order, kind, revision, parent). A retry of the same
    -- decision finds this row instead of creating a second one.
    idempotency_key      text NOT NULL CHECK (char_length(idempotency_key) = 64),
    -- «شماره ارجاع» — the taxpayer's own number for the invoice, unique per business.
    reference_number     text NOT NULL CHECK (char_length(reference_number) BETWEEN 1 AND 64),
    -- «شناسه یکتای ارسال صورتحساب» — a UUID generated by the sender before the
    -- first send and reused on every retry; the authority deduplicates on it.
    uid                  text NOT NULL
                         CHECK (uid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    -- «رسید یکتای دریافت» — the receipt the authority returns once it has the packet.
    receipt_id           text CHECK (receipt_id IS NULL OR char_length(receipt_id) BETWEEN 1 AND 128),
    environment          text NOT NULL CHECK (environment IN ('sandbox', 'production')),
    provider             text NOT NULL CHECK (provider IN ('sandbox', 'moodian')),
    payload_version      text NOT NULL CHECK (char_length(payload_version) BETWEEN 1 AND 64),
    payload_snapshot     jsonb NOT NULL,
    payload_hash         text NOT NULL CHECK (char_length(payload_hash) = 64),
    subtotal_rial        bigint NOT NULL CHECK (subtotal_rial >= 0),
    discount_rial        bigint NOT NULL CHECK (discount_rial >= 0),
    vat_rial             bigint NOT NULL CHECK (vat_rial >= 0),
    total_rial           bigint NOT NULL CHECK (total_rial >= 0),
    status               text NOT NULL CHECK (status IN (
                             'prepared', 'queued', 'sending', 'submitted', 'awaiting_inquiry',
                             'accepted', 'rejected', 'error', 'cancelled')),
    attempts             integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at      timestamptz,
    leased_until         timestamptz,
    last_error_code      text,
    last_error_message   text,
    provider_errors      jsonb NOT NULL DEFAULT '[]'::jsonb,
    inquiry_result       jsonb,
    last_inquired_at     timestamptz,
    correlation_id       text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 64),
    prepared_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    prepared_at          timestamptz NOT NULL DEFAULT now(),
    queued_at            timestamptz,
    submitted_at         timestamptz,
    accepted_at          timestamptz,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, idempotency_key),
    UNIQUE (business_id, reference_number),
    UNIQUE (business_id, uid),
    UNIQUE (business_id, order_id, kind, revision)
);

-- A sale has one live record at a time. "Live" excludes a rejected record (the
-- operator resubmits as a new revision) and a cancelled one (already withdrawn).
CREATE UNIQUE INDEX tax_one_live_sale_per_order
    ON tax_invoice_submissions (business_id, order_id)
    WHERE kind = 'sale' AND status NOT IN ('rejected', 'cancelled');

-- An accepted record has at most one live correction at a time.
CREATE UNIQUE INDEX tax_one_live_correction_per_parent
    ON tax_invoice_submissions (business_id, parent_submission_id)
    WHERE parent_submission_id IS NOT NULL AND status NOT IN ('rejected', 'cancelled');

-- A receipt from the authority identifies exactly one record.
CREATE UNIQUE INDEX tax_receipt_per_business
    ON tax_invoice_submissions (business_id, receipt_id)
    WHERE receipt_id IS NOT NULL;

-- The worker's due list: records with work waiting, in the order they are due.
CREATE INDEX tax_submissions_due
    ON tax_invoice_submissions (next_attempt_at)
    WHERE status IN ('queued', 'sending', 'submitted', 'awaiting_inquiry');

CREATE INDEX tax_submissions_order ON tax_invoice_submissions (business_id, order_id);
CREATE INDEX tax_submissions_register
    ON tax_invoice_submissions (business_id, location_id, prepared_at DESC, id);

-- The one place the status machine is written down in SQL. Mirrored, and tested
-- against, `TAX_STATUS_TRANSITIONS` in src/lib/tax-invoice.ts.
CREATE FUNCTION tax_status_transition_allowed(from_status text, to_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE from_status
        WHEN 'prepared'         THEN to_status IN ('queued')
        WHEN 'queued'           THEN to_status IN ('sending')
        WHEN 'sending'          THEN to_status IN ('submitted', 'awaiting_inquiry', 'queued', 'rejected', 'error')
        WHEN 'submitted'        THEN to_status IN ('accepted', 'rejected', 'awaiting_inquiry')
        WHEN 'awaiting_inquiry' THEN to_status IN ('submitted', 'accepted', 'rejected', 'queued', 'error')
        WHEN 'error'            THEN to_status IN ('queued')
        WHEN 'accepted'         THEN to_status IN ('cancelled')
        ELSE false
    END
$$;

CREATE FUNCTION tax_submission_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Retention and platform deletion may purge a business's records, and
        -- they say so per transaction. Nothing else may remove one.
        IF current_setting('app.tax_submission_purge', true) = 'on' THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'tax_submission_immutable: a taxpayer submission is never deleted'
            USING ERRCODE = 'check_violation';
    END IF;

    IF (NEW.business_id, NEW.location_id, NEW.order_id, NEW.kind, NEW.revision,
        NEW.parent_submission_id, NEW.idempotency_key, NEW.reference_number, NEW.uid,
        NEW.environment, NEW.provider, NEW.payload_version, NEW.payload_snapshot,
        NEW.payload_hash, NEW.subtotal_rial, NEW.discount_rial, NEW.vat_rial,
        NEW.total_rial, NEW.correlation_id, NEW.prepared_at, NEW.prepared_by)
       IS DISTINCT FROM
       (OLD.business_id, OLD.location_id, OLD.order_id, OLD.kind, OLD.revision,
        OLD.parent_submission_id, OLD.idempotency_key, OLD.reference_number, OLD.uid,
        OLD.environment, OLD.provider, OLD.payload_version, OLD.payload_snapshot,
        OLD.payload_hash, OLD.subtotal_rial, OLD.discount_rial, OLD.vat_rial,
        OLD.total_rial, OLD.correlation_id, OLD.prepared_at, OLD.prepared_by) THEN
        RAISE EXCEPTION 'tax_submission_immutable: a submission''s identity and payload cannot change'
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id THEN
        RAISE EXCEPTION 'tax_submission_immutable: a receipt is recorded once'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT tax_status_transition_allowed(OLD.status, NEW.status) THEN
        RAISE EXCEPTION 'tax_submission_transition: % -> % is not allowed', OLD.status, NEW.status
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tax_submission_guard
    BEFORE UPDATE OR DELETE ON tax_invoice_submissions
    FOR EACH ROW EXECUTE FUNCTION tax_submission_guard();

-- 5. Append-only history: one row per decision, never edited -------------------
CREATE TABLE tax_invoice_events (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    submission_id  uuid NOT NULL REFERENCES tax_invoice_submissions(id) ON DELETE RESTRICT,
    event_type     text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 64),
    from_status    text,
    to_status      text,
    actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 64),
    detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tax_invoice_events_submission
    ON tax_invoice_events (submission_id, created_at, id);

CREATE FUNCTION tax_invoice_events_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('app.tax_submission_purge', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'tax_invoice_events is append-only' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER tax_invoice_events_append_only
    BEFORE UPDATE OR DELETE ON tax_invoice_events
    FOR EACH ROW EXECUTE FUNCTION tax_invoice_events_append_only();

-- Tenant isolation — the standard template, applied to every table above. -----
ALTER TABLE tax_invoice_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_invoice_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_invoice_profiles FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE tax_invoice_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_invoice_units FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_invoice_units FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE tax_item_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_item_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_item_codes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE tax_invoice_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_invoice_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_invoice_submissions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE tax_invoice_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_invoice_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_invoice_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
