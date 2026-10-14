-- ============================================================================
-- 0217_payroll_engine_corrections.sql — issue #865, second pass over 0216.
--
-- 1. Snapshot integrity (root-cause fix). 0216's payroll_payslips_guard read
--    the status of NEW.run_id only, so on UPDATE a payslip could be moved
--    *out of* an approved run into a draft one (and edited on the way):
--    the destination was a draft, so the guard let it through and the approved
--    snapshot silently lost a payslip. Now:
--      - a payslip's run_id and business_id never change after insert;
--      - both the original and the destination run are checked (they are the
--        same row by the rule above, but the check reads OLD explicitly);
--      - a payslip belongs to its run's business, enforced by a composite FK
--        (run_id, business_id) → payroll_engine_runs(id, business_id).
--    The same "identity never moves" rule is added to payroll_engine_runs
--    (business_id / period_key / run_type / sequence) for every status.
--
-- 2. Signed corrections. A downward supplemental correction can leave an
--    employee owing money. Net pay stays ≥ 0; what the employee owes is
--    `employee_debt`, posted Debit 1260 (staff advances / receivable) and
--    recovered by later regular runs through the same advance-recovery
--    mechanism #835 uses (payroll-advances-service.outstandingAdvances).
--
-- 3. Correction inputs and partial months are snapshotted on the payslip so a
--    later supplemental run can correct them on the cumulative month:
--    base_salary (the monthly contract rate used), worked_days (days employed
--    in the month on the rule's month basis), overtime_hours, unpaid_leave_days.
--
-- 4. Dimensioned posting. A run's accrual is now one balanced journal entry per
--    cost-allocation bucket (branch × project), so `accrual_entry_id` becomes
--    `accrual_entry_ids`.
-- ============================================================================

SELECT set_config('app.rls_bypass', 'on', true);

-- Composite identity so a payslip cannot point at another business's run.
ALTER TABLE payroll_engine_runs
    ADD CONSTRAINT payroll_engine_runs_id_business_unique UNIQUE (id, business_id);
ALTER TABLE payroll_payslips
    ADD CONSTRAINT payroll_payslips_run_business_fk
        FOREIGN KEY (run_id, business_id) REFERENCES payroll_engine_runs (id, business_id) ON DELETE CASCADE;

-- New snapshot columns. Added before the guard is replaced; existing rows get
-- the neutral defaults (a full month, no corrections, no debt).
ALTER TABLE payroll_payslips
    ADD COLUMN base_salary       bigint NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
    ADD COLUMN worked_days       numeric(5, 2) NOT NULL DEFAULT 0 CHECK (worked_days >= 0 AND worked_days <= 31),
    ADD COLUMN overtime_hours    numeric(7, 2) NOT NULL DEFAULT 0,
    ADD COLUMN unpaid_leave_days numeric(5, 2) NOT NULL DEFAULT 0,
    ADD COLUMN employee_debt     bigint NOT NULL DEFAULT 0 CHECK (employee_debt >= 0),
    ADD CONSTRAINT payroll_payslips_net_or_debt CHECK (net_pay = 0 OR employee_debt = 0);

ALTER TABLE payroll_engine_runs
    ADD COLUMN accrual_entry_ids uuid[] NOT NULL DEFAULT '{}';
UPDATE payroll_engine_runs SET accrual_entry_ids = ARRAY[accrual_entry_id] WHERE accrual_entry_id IS NOT NULL;
ALTER TABLE payroll_engine_runs DROP COLUMN accrual_entry_id;

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

CREATE OR REPLACE FUNCTION payroll_payslips_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    frozen text[] := ARRAY['approved', 'posted', 'paid', 'closed'];
    old_status text;
    new_status text;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT status INTO old_status FROM payroll_engine_runs WHERE id = OLD.run_id;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT status INTO new_status FROM payroll_engine_runs WHERE id = NEW.run_id;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF old_status = ANY(frozen) AND NOT app_rls_bypass() THEN
            RAISE EXCEPTION 'payslips of an approved run cannot be deleted' USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF new_status = ANY(frozen) THEN
            RAISE EXCEPTION 'cannot add payslips to an approved run' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE: a payslip never moves between runs or businesses, whatever the status.
    IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.business_id IS DISTINCT FROM OLD.business_id THEN
        RAISE EXCEPTION 'a payslip cannot be moved to another run' USING ERRCODE = '55000';
    END IF;
    IF old_status = ANY(frozen) OR new_status = ANY(frozen) THEN
        IF (to_jsonb(NEW) - ARRAY['payment_status', 'paid_at', 'user_id'])
           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['payment_status', 'paid_at', 'user_id'])
           OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL) THEN
            RAISE EXCEPTION 'payslips of an approved run are immutable' USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END
$$;
