-- ============================================================================
-- 0218_payroll_engine_audit_and_replay_identity.sql — issue #865 follow-up.
--
-- Persist the normalized create request beside its idempotency key so a replay
-- can be compared with the immutable original request (not with draft edits),
-- and audit each recurring payroll-item add/end with actor and time. The new
-- audit table is tenant-scoped with RLS in the same migration.
-- ============================================================================

ALTER TABLE payroll_engine_runs
    ADD COLUMN idempotency_payload jsonb;

-- Old rows predate payload binding. Their original requests cannot be
-- reconstructed from the current run because draft edits may already have
-- changed its inputs, commission flag, or note. Mark them explicitly as
-- non-replayable rather than treating mutable draft state as the original.
UPDATE payroll_engine_runs
   SET idempotency_payload = jsonb_build_object('legacy', true)
 WHERE idempotency_key IS NOT NULL;

ALTER TABLE payroll_engine_runs
    ADD CONSTRAINT payroll_engine_runs_idempotency_payload_object
        CHECK (idempotency_payload IS NULL OR jsonb_typeof(idempotency_payload) = 'object'),
    ADD CONSTRAINT payroll_engine_runs_idempotency_payload_for_key
        CHECK ((idempotency_key IS NULL) = (idempotency_payload IS NULL));

-- The payload and key are immutable even while the run is still a draft. The
-- status guard from 0217 continues to govern the later financial lifecycle.
CREATE OR REPLACE FUNCTION payroll_engine_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    lifecycle text[] := ARRAY['status', 'accrual_entry_ids', 'payment_entry_id', 'paid_date',
                              'posted_by', 'posted_at', 'paid_by', 'closed_by', 'closed_at'];
    allowed boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('approved', 'posted', 'paid', 'closed') AND NOT app_rls_bypass() THEN
            RAISE EXCEPTION 'approved payroll runs cannot be deleted' USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.period_key IS DISTINCT FROM OLD.period_key
       OR NEW.run_type IS DISTINCT FROM OLD.run_type OR NEW.sequence IS DISTINCT FROM OLD.sequence THEN
        RAISE EXCEPTION 'a payroll run''s identity cannot change' USING ERRCODE = '55000';
    END IF;
    IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.idempotency_payload IS DISTINCT FROM OLD.idempotency_payload THEN
        RAISE EXCEPTION 'a payroll run''s idempotency identity cannot change' USING ERRCODE = '55000';
    END IF;
    IF OLD.status IN ('approved', 'posted', 'paid', 'closed') THEN
        IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
            RAISE EXCEPTION 'approved payroll runs are immutable' USING ERRCODE = '55000';
        END IF;
        allowed := (OLD.status = NEW.status)
                OR (OLD.status = 'approved' AND NEW.status = 'posted')
                OR (OLD.status = 'posted' AND NEW.status = 'paid')
                OR (OLD.status = 'paid' AND NEW.status = 'closed');
        IF NOT allowed THEN
            RAISE EXCEPTION 'invalid payroll run transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

-- Previous profile-audit rows copied bank and identity numbers in full. Keep
-- the audit trail's field-presence context but stop retaining the raw values.
UPDATE payroll_profile_changes
   SET before = jsonb_set(
       jsonb_set(
         jsonb_set(before, '{insuranceProfile}', COALESCE(before->'insuranceProfile', '{}'::jsonb) - 'insuranceNumber', true),
         '{taxProfile}', COALESCE(before->'taxProfile', '{}'::jsonb) - 'nationalId', true),
       '{paymentDestination}', COALESCE(before->'paymentDestination', '{}'::jsonb) - 'iban' - 'cardNumber', true)
 WHERE before IS NOT NULL;
UPDATE payroll_profile_changes
   SET after = jsonb_set(
       jsonb_set(
         jsonb_set(after, '{insuranceProfile}', COALESCE(after->'insuranceProfile', '{}'::jsonb) - 'insuranceNumber', true),
         '{taxProfile}', COALESCE(after->'taxProfile', '{}'::jsonb) - 'nationalId', true),
       '{paymentDestination}', COALESCE(after->'paymentDestination', '{}'::jsonb) - 'iban' - 'cardNumber', true);

ALTER TABLE payroll_employee_items
    ADD CONSTRAINT payroll_employee_items_id_business_unique UNIQUE (id, business_id);

CREATE TABLE payroll_employee_item_changes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    item_id     uuid NOT NULL,
    before      jsonb,
    after       jsonb NOT NULL,
    changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    changed_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payroll_item_changes_item_business_fk
        FOREIGN KEY (item_id, business_id)
        REFERENCES payroll_employee_items (id, business_id) ON DELETE CASCADE
);
CREATE INDEX idx_payroll_employee_item_changes
    ON payroll_employee_item_changes (business_id, item_id, changed_at DESC, id DESC);
CREATE TRIGGER trg_payroll_employee_item_changes_append_only
    BEFORE UPDATE OR DELETE ON payroll_employee_item_changes
    FOR EACH ROW EXECUTE FUNCTION payroll_engine_append_only();

ALTER TABLE payroll_employee_item_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_employee_item_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payroll_employee_item_changes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
