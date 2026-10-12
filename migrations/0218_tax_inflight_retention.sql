-- Pending provider truth cannot be erased by deleting its internal source.
CREATE FUNCTION tax_inflight_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('sending', 'submitted', 'awaiting_inquiry') THEN
        RAISE EXCEPTION 'tax_inflight_retained: resolve provider delivery before purging' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER tax_inflight_retention BEFORE DELETE ON tax_invoice_submissions
    FOR EACH ROW EXECUTE FUNCTION tax_inflight_retention_guard();

-- A tenant cannot attach an archive to another tenant's record by guessing its UUID.
CREATE FUNCTION tax_archive_tenant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM tax_invoice_submissions
                   WHERE id = NEW.submission_id AND business_id = NEW.business_id) THEN
        RAISE EXCEPTION 'tax_archive_tenant_mismatch' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER tax_archive_tenant_guard BEFORE INSERT ON tax_invoice_archives
    FOR EACH ROW EXECUTE FUNCTION tax_archive_tenant_guard();
