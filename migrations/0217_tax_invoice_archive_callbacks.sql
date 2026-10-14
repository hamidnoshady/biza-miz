-- Forward-only follow-up to 0216. Archival NEVER expires/deletes submissions.
-- The age is an operational threshold, not a legal retention duration.
ALTER TABLE tax_invoice_profiles ADD COLUMN archive_after_days integer NOT NULL DEFAULT 365
    CHECK (archive_after_days BETWEEN 1 AND 36500);

CREATE TABLE tax_invoice_archives (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    submission_id uuid NOT NULL UNIQUE REFERENCES tax_invoice_submissions(id) ON DELETE RESTRICT,
    format_version text NOT NULL DEFAULT 'tax-archive/v1' CHECK (format_version = 'tax-archive/v1'),
    snapshot jsonb NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    archived_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tax_invoice_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_invoice_archives FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_invoice_archives FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Reuse the append-only guard: UPDATE is always refused; DELETE requires the
-- existing transaction-local purge flag. Accepted history is never purgeable.
CREATE TRIGGER tax_invoice_archives_append_only BEFORE UPDATE OR DELETE ON tax_invoice_archives
    FOR EACH ROW EXECUTE FUNCTION tax_invoice_events_append_only();
CREATE FUNCTION tax_accepted_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'tax_invoice_archives' THEN
        IF EXISTS (SELECT 1 FROM tax_invoice_submissions WHERE id = OLD.submission_id
                    AND (accepted_at IS NOT NULL OR status = 'accepted')) THEN
            RAISE EXCEPTION 'tax_accepted_retained: accepted history is retained indefinitely' USING ERRCODE = 'check_violation';
        END IF;
    ELSIF OLD.accepted_at IS NOT NULL OR OLD.status = 'accepted' THEN
        RAISE EXCEPTION 'tax_accepted_retained: accepted history is retained indefinitely' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER tax_accepted_retention BEFORE DELETE ON tax_invoice_submissions
    FOR EACH ROW EXECUTE FUNCTION tax_accepted_retention_guard();
CREATE TRIGGER tax_archive_accepted_retention BEFORE DELETE ON tax_invoice_archives
    FOR EACH ROW EXECUTE FUNCTION tax_accepted_retention_guard();
-- History of an accepted invoice is retained too, including after cancellation.
CREATE FUNCTION tax_accepted_event_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM tax_invoice_submissions WHERE id = OLD.submission_id
               AND (accepted_at IS NOT NULL OR status = 'accepted')) THEN
        RAISE EXCEPTION 'tax_accepted_retained: accepted events are retained indefinitely' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER tax_accepted_event_retention BEFORE DELETE ON tax_invoice_events
    FOR EACH ROW EXECUTE FUNCTION tax_accepted_event_retention_guard();

ALTER TABLE tax_invoice_events ADD COLUMN callback_event_id text
    CHECK (callback_event_id IS NULL OR char_length(callback_event_id) BETWEEN 1 AND 128);
ALTER TABLE tax_invoice_events ADD COLUMN callback_hash text
    CHECK (callback_hash IS NULL OR callback_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE tax_invoice_events ADD CONSTRAINT tax_callback_identity_pair
    CHECK ((callback_event_id IS NULL) = (callback_hash IS NULL));
CREATE UNIQUE INDEX tax_callback_delivery ON tax_invoice_events (business_id, callback_event_id)
    WHERE callback_event_id IS NOT NULL;

-- Retention anchors cannot be cleared to evade the delete guard.
CREATE FUNCTION tax_acceptance_anchor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
        RAISE EXCEPTION 'tax_accepted_retained: acceptance timestamp is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'accepted' AND NEW.accepted_at IS NULL THEN
        NEW.accepted_at := now();
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER tax_acceptance_anchor BEFORE UPDATE ON tax_invoice_submissions
    FOR EACH ROW EXECUTE FUNCTION tax_acceptance_anchor_guard();
