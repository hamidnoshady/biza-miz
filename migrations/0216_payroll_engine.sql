-- ============================================================================
-- 0216_payroll_engine.sql — issue #865: the full statutory payroll engine.
--
-- A new module ON TOP of #835 (0214/0215). #835's `payroll_runs` stays the
-- journal-level accrual/payment helper and is not touched; the engine owns its
-- own tables and posts through the same ledger path (fiscal locks included).
-- A month is booked by ONE of the two, never both: each side refuses a period
-- the other already holds (checked in the services under the shared payroll
-- advisory lock).
--
--   payroll_rule_sets          versioned statutory parameters (append-only)
--   payroll_components         earning / deduction / employer-contribution catalogue
--   payroll_component_changes  audit history of the catalogue (append-only)
--   payroll_employee_profiles  payroll profile beside the canonical users/employees identity
--   payroll_profile_changes    audit history of profiles (append-only)
--   payroll_employee_items     recurring allowances / deductions / benefits, effective-dated
--   payroll_engine_runs        draft → calculated → reviewed → approved → posted → paid → closed
--   payroll_payslips           per-employee calculation snapshot, immutable after approval
--
-- Every table is tenant-scoped with RLS in this migration (CLAUDE.md).
-- ============================================================================

-- 1. Versioned rule sets -----------------------------------------------------
CREATE TABLE payroll_rule_sets (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    version        integer NOT NULL CHECK (version > 0),
    title          text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
    effective_from date NOT NULL,
    rules          jsonb NOT NULL,
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, version)
);
CREATE INDEX idx_payroll_rule_sets_effective ON payroll_rule_sets (business_id, effective_from DESC, version DESC);

-- 2. Component catalogue + audit --------------------------------------------
CREATE TABLE payroll_components (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    code                text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,32}$'),
    name                text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    kind                text NOT NULL CHECK (kind IN ('earning', 'deduction', 'employer_contribution')),
    system_key          text,
    taxable             boolean NOT NULL DEFAULT false,
    insurable           boolean NOT NULL DEFAULT false,
    debit_account_code  text NOT NULL,
    credit_account_code text NOT NULL,
    effective_from      date NOT NULL DEFAULT DATE '2000-01-01',
    effective_to        date,
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, code),
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX uq_payroll_components_system_key
    ON payroll_components (business_id, system_key) WHERE system_key IS NOT NULL;

CREATE TABLE payroll_component_changes (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    component_id uuid NOT NULL REFERENCES payroll_components(id) ON DELETE CASCADE,
    before       jsonb,
    after        jsonb NOT NULL,
    changed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payroll_component_changes ON payroll_component_changes (business_id, component_id, changed_at DESC);

-- 3. Employee payroll profile + audit ----------------------------------------
CREATE TABLE payroll_employee_profiles (
    user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    payroll_code     text CHECK (payroll_code IS NULL OR char_length(btrim(payroll_code)) BETWEEN 1 AND 40),
    employment_type  text NOT NULL DEFAULT 'full_time'
                     CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'hourly', 'intern')),
    hire_date        date,
    termination_date date,
    base_salary      bigint NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
    -- { insured: bool, insuranceNumber?: text }
    insurance_profile jsonb NOT NULL DEFAULT '{"insured": true}'::jsonb,
    -- { exempt: bool, nationalId?: text }
    tax_profile      jsonb NOT NULL DEFAULT '{"exempt": false}'::jsonb,
    -- { method: 'cash'|'bank', paymentAccountId?: uuid, iban?: text, cardNumber?: text }
    payment_destination jsonb NOT NULL DEFAULT '{"method": "bank"}'::jsonb,
    -- [{ percent, locationId?, projectId?, label? }] summing to 100, or []
    cost_allocation  jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (termination_date IS NULL OR hire_date IS NULL OR termination_date >= hire_date)
);
CREATE UNIQUE INDEX uq_payroll_profiles_code
    ON payroll_employee_profiles (business_id, payroll_code) WHERE payroll_code IS NOT NULL;

CREATE TABLE payroll_profile_changes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    before      jsonb,
    after       jsonb NOT NULL,
    changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payroll_profile_changes ON payroll_profile_changes (business_id, user_id, changed_at DESC);

-- 4. Recurring items -----------------------------------------------------------
CREATE TABLE payroll_employee_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    component_id   uuid NOT NULL REFERENCES payroll_components(id) ON DELETE RESTRICT,
    amount         bigint NOT NULL CHECK (amount > 0),
    effective_from date NOT NULL,
    effective_to   date,
    note           text CHECK (note IS NULL OR char_length(note) <= 200),
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    ended_at       timestamptz,
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX idx_payroll_employee_items ON payroll_employee_items (business_id, user_id);

-- 5. Runs ------------------------------------------------------------------------
CREATE TABLE payroll_engine_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    period_key          text NOT NULL CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    run_type            text NOT NULL CHECK (run_type IN ('regular', 'supplemental')),
    sequence            integer NOT NULL CHECK (sequence > 0),
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'calculated', 'reviewed', 'approved', 'posted', 'paid', 'closed', 'cancelled')),
    accrual_date        date NOT NULL,
    include_commission  boolean NOT NULL DEFAULT false,
    note                text CHECK (note IS NULL OR char_length(note) <= 500),
    -- Per-employee inputs of this run: { [userId]: { overtimeHours, unpaidLeaveDays, items: [{code, amount}] } }
    inputs              jsonb NOT NULL DEFAULT '{}'::jsonb,
    rule_set_id         uuid REFERENCES payroll_rule_sets(id) ON DELETE RESTRICT,
    rule_snapshot       jsonb,
    components_snapshot jsonb,
    totals              jsonb,
    idempotency_key     text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 128),
    accrual_entry_id    uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
    payment_entry_id    uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
    paid_date           date,
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    calculated_at       timestamptz,
    reviewed_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at         timestamptz,
    approved_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at         timestamptz,
    posted_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    posted_at           timestamptz,
    paid_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    closed_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    closed_at           timestamptz,
    cancelled_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at        timestamptz,
    UNIQUE (business_id, period_key, sequence)
);
-- Deterministic period identity: one standing regular run per month.
CREATE UNIQUE INDEX uq_payroll_engine_runs_regular
    ON payroll_engine_runs (business_id, period_key)
    WHERE run_type = 'regular' AND status <> 'cancelled';
CREATE UNIQUE INDEX uq_payroll_engine_runs_idempotency
    ON payroll_engine_runs (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_payroll_engine_runs_history
    ON payroll_engine_runs (business_id, period_key DESC, sequence DESC);

-- An approved run is a frozen calculation: from 'approved' on, only the
-- lifecycle columns may change, and only forward along the workflow.
CREATE FUNCTION payroll_engine_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    lifecycle text[] := ARRAY['status', 'accrual_entry_id', 'payment_entry_id', 'paid_date',
                              'posted_by', 'posted_at', 'paid_by', 'closed_by', 'closed_at'];
    allowed boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('approved', 'posted', 'paid', 'closed') AND NOT app_rls_bypass() THEN
            RAISE EXCEPTION 'approved payroll runs cannot be deleted' USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
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
CREATE TRIGGER trg_payroll_engine_runs_guard
    BEFORE UPDATE OR DELETE ON payroll_engine_runs
    FOR EACH ROW EXECUTE FUNCTION payroll_engine_runs_guard();

-- 6. Payslips ----------------------------------------------------------------------
CREATE TABLE payroll_payslips (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    run_id                 uuid NOT NULL REFERENCES payroll_engine_runs(id) ON DELETE CASCADE,
    user_id                uuid REFERENCES users(id) ON DELETE SET NULL,
    employee_name_snapshot text NOT NULL,
    employee_code_snapshot text,
    gross                  bigint NOT NULL,
    insurable_raw          bigint NOT NULL,
    insurance_base         bigint NOT NULL,
    employee_insurance     bigint NOT NULL,
    employer_insurance     bigint NOT NULL,
    unemployment_insurance bigint NOT NULL,
    taxable_base           bigint NOT NULL,
    income_tax             bigint NOT NULL,
    commission             bigint NOT NULL DEFAULT 0,
    advance_recovery       bigint NOT NULL DEFAULT 0,
    total_deductions       bigint NOT NULL,
    net_pay                bigint NOT NULL CHECK (net_pay >= 0),
    employer_cost          bigint NOT NULL,
    lines                  jsonb NOT NULL,
    cost_allocation        jsonb NOT NULL DEFAULT '[]'::jsonb,
    payment_status         text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
    paid_at                date,
    created_at             timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, user_id)
);
CREATE INDEX idx_payroll_payslips_user ON payroll_payslips (business_id, user_id);

-- A payslip of an approved run is a snapshot: only the payment status (and the
-- referential user_id → NULL) may change, and it cannot be deleted.
CREATE FUNCTION payroll_payslips_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    run_status text;
BEGIN
    SELECT status INTO run_status FROM payroll_engine_runs
     WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;
    IF run_status IN ('approved', 'posted', 'paid', 'closed') THEN
        IF TG_OP = 'DELETE' THEN
            IF NOT app_rls_bypass() THEN
                RAISE EXCEPTION 'payslips of an approved run cannot be deleted' USING ERRCODE = '55000';
            END IF;
            RETURN OLD;
        END IF;
        IF TG_OP = 'INSERT' THEN
            RAISE EXCEPTION 'cannot add payslips to an approved run' USING ERRCODE = '55000';
        END IF;
        IF (to_jsonb(NEW) - ARRAY['payment_status', 'paid_at', 'user_id'])
           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['payment_status', 'paid_at', 'user_id'])
           OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL) THEN
            RAISE EXCEPTION 'payslips of an approved run are immutable' USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER trg_payroll_payslips_guard
    BEFORE INSERT OR UPDATE OR DELETE ON payroll_payslips
    FOR EACH ROW EXECUTE FUNCTION payroll_payslips_guard();

-- Commission included in an engine payslip is claimed by that run (one claim
-- column per settlement path → never settled twice; #835's column untouched).
ALTER TABLE commission_accruals
    ADD COLUMN payroll_engine_run_id uuid REFERENCES payroll_engine_runs(id) ON DELETE SET NULL;
CREATE INDEX idx_commission_accruals_engine_run
    ON commission_accruals (payroll_engine_run_id) WHERE payroll_engine_run_id IS NOT NULL;

-- Append-only audit / version tables.
CREATE FUNCTION payroll_engine_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND app_rls_bypass() THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER trg_payroll_rule_sets_append_only BEFORE UPDATE OR DELETE ON payroll_rule_sets
    FOR EACH ROW EXECUTE FUNCTION payroll_engine_append_only();
CREATE TRIGGER trg_payroll_component_changes_append_only BEFORE UPDATE OR DELETE ON payroll_component_changes
    FOR EACH ROW EXECUTE FUNCTION payroll_engine_append_only();
CREATE TRIGGER trg_payroll_profile_changes_append_only BEFORE UPDATE OR DELETE ON payroll_profile_changes
    FOR EACH ROW EXECUTE FUNCTION payroll_engine_append_only();

-- 7. Tenant isolation ------------------------------------------------------------
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['payroll_rule_sets', 'payroll_components', 'payroll_component_changes',
                             'payroll_employee_profiles', 'payroll_profile_changes', 'payroll_employee_items',
                             'payroll_engine_runs', 'payroll_payslips']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I FOR ALL
                USING (app_rls_bypass() OR business_id = app_current_business())
                WITH CHECK (app_rls_bypass() OR business_id = app_current_business())', t);
    END LOOP;
END
$$;
