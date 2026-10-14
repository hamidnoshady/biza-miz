-- Preserve disputed provider evidence without mislabelling it as accepted_at.
-- Holds are indefinite and cannot be cleared through normal application writes.
ALTER TABLE tax_invoice_submissions ADD COLUMN retention_hold_at timestamptz;
CREATE FUNCTION tax_retention_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.retention_hold_at IS NOT NULL THEN
        RAISE EXCEPTION 'tax_retention_hold: disputed provider evidence is retained indefinitely' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.retention_hold_at IS NOT NULL
       AND NEW.retention_hold_at IS DISTINCT FROM OLD.retention_hold_at THEN
        RAISE EXCEPTION 'tax_retention_hold: retention hold is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER tax_retention_hold BEFORE UPDATE OR DELETE ON tax_invoice_submissions
    FOR EACH ROW EXECUTE FUNCTION tax_retention_hold_guard();
CREATE FUNCTION tax_retention_hold_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM tax_invoice_submissions WHERE id = OLD.submission_id AND retention_hold_at IS NOT NULL) THEN
        RAISE EXCEPTION 'tax_retention_hold: disputed provider evidence is retained indefinitely' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER tax_retention_hold BEFORE DELETE ON tax_invoice_events
    FOR EACH ROW EXECUTE FUNCTION tax_retention_hold_child_guard();
CREATE TRIGGER tax_retention_hold BEFORE DELETE ON tax_invoice_archives
    FOR EACH ROW EXECUTE FUNCTION tax_retention_hold_child_guard();

-- Prior feature builds could exhaust ambiguous delivery into retryable 'error'.
-- Do not silently change terminal status/history or give permission to resend.
-- A later explicit not_received event resolves that particular ambiguity.
UPDATE tax_invoice_submissions s SET retention_hold_at = now()
 WHERE s.status IN ('error', 'queued') AND EXISTS (
    SELECT 1 FROM tax_invoice_events e WHERE e.submission_id = s.id
      AND e.event_type = 'send_failed' AND e.detail->>'failure' = 'unknown_delivery'
      AND NOT EXISTS (SELECT 1 FROM tax_invoice_events resolved
        WHERE resolved.submission_id = s.id AND resolved.event_type = 'not_received'
          AND resolved.created_at > e.created_at)
 );
INSERT INTO tax_invoice_events (business_id, submission_id, event_type, correlation_id, detail)
 SELECT business_id, id, 'delivery_hold', correlation_id,
        '{"reason":"legacy ambiguous delivery requires manual provider reconciliation"}'::jsonb
 FROM tax_invoice_submissions WHERE retention_hold_at IS NOT NULL;
