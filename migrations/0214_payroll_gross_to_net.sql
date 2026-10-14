-- ============================================================================
-- 0214_payroll_gross_to_net.sql — audit F11 (payroll half).
--
-- Payroll used to accrue each person's monthly amount as one gross figure
-- under a free-text period. This migration gives it what a gross-to-net run
-- needs, with every *rate* left to the business (SETTING_KEYS.payroll in the
-- existing `settings` table — nothing statutory is stored here):
--
--   1. Three account headings on every chart, additive and idempotent exactly
--      like 0094/0135 (a business that already has a code keeps it as it is):
--        1260 مساعده و علی‌الحساب کارکنان  (asset)     — salary advances paid out
--        5220 بیمه سهم کارفرما            (expense)   — employer + unemployment share
--        2490 سایر کسور حقوق پرداختنی      (liability) — other deductions withheld
--      2460 بیمه پرداختنی and 2470 مالیات حقوق پرداختنی already exist (0094).
--   2. Per-employee standing terms beside `users.monthly_wage` (0031):
--      taxable / non-taxable allowances and a fixed monthly deduction.
--   3. A run is a Jalali month (`period_key`, `YYYY-MM`) — one standing run per
--      month, enforced by a partial UNIQUE index rather than a read-then-write.
--      Old runs keep their free-text `period_label` and a NULL key.
--   4. Each run line stores its full breakdown, and the run its net total and
--      the settings it was computed with, so a past run is auditable after the
--      rates change.
--   5. `payroll_advances` — a salary advance (مساعده) paid to a member, which a
--      later run recovers. What is still owed is derived (advances minus the
--      recoveries of standing runs), never a mutable balance column, so voiding
--      a run gives its recovery back by construction.
-- ============================================================================

-- 1. Accounts -----------------------------------------------------------------
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
CROSS JOIN (VALUES
  ('1260', 'مساعده و علی‌الحساب کارکنان', 'asset',   '1000'),
  ('5220', 'بیمه سهم کارفرما',           'expense', '5000')
) v(code, name, type, parent)
JOIN accounts p ON p.business_id = b.id AND p.code = v.parent
ON CONFLICT (business_id, code) DO NOTHING;

INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, '2490', 'سایر کسور حقوق پرداختنی', 'liability'::account_type, 'moein'::account_level, false
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '2300'
ON CONFLICT (business_id, code) DO NOTHING;

-- 2. Standing per-employee terms ---------------------------------------------
ALTER TABLE users
    ADD COLUMN monthly_taxable_allowance     bigint NOT NULL DEFAULT 0 CHECK (monthly_taxable_allowance >= 0),
    ADD COLUMN monthly_non_taxable_allowance bigint NOT NULL DEFAULT 0 CHECK (monthly_non_taxable_allowance >= 0),
    ADD COLUMN monthly_fixed_deduction       bigint NOT NULL DEFAULT 0 CHECK (monthly_fixed_deduction >= 0);

-- 3 + 4. Runs and lines ---------------------------------------------------------
ALTER TABLE payroll_runs
    ADD COLUMN period_key        text CHECK (period_key IS NULL OR period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    ADD COLUMN net_amount        bigint CHECK (net_amount IS NULL OR net_amount >= 0),
    ADD COLUMN settings_snapshot jsonb;

CREATE UNIQUE INDEX uq_payroll_runs_period
    ON payroll_runs (business_id, period_key)
    WHERE period_key IS NOT NULL AND status <> 'voided';

ALTER TABLE payroll_run_lines
    ADD COLUMN base_salary              bigint NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
    ADD COLUMN taxable_allowance        bigint NOT NULL DEFAULT 0 CHECK (taxable_allowance >= 0),
    ADD COLUMN non_taxable_allowance    bigint NOT NULL DEFAULT 0 CHECK (non_taxable_allowance >= 0),
    ADD COLUMN overtime                 bigint NOT NULL DEFAULT 0 CHECK (overtime >= 0),
    ADD COLUMN insurance_base           bigint NOT NULL DEFAULT 0 CHECK (insurance_base >= 0),
    ADD COLUMN employee_insurance       bigint NOT NULL DEFAULT 0 CHECK (employee_insurance >= 0),
    ADD COLUMN employer_insurance       bigint NOT NULL DEFAULT 0 CHECK (employer_insurance >= 0),
    ADD COLUMN unemployment_insurance   bigint NOT NULL DEFAULT 0 CHECK (unemployment_insurance >= 0),
    ADD COLUMN taxable_income           bigint NOT NULL DEFAULT 0 CHECK (taxable_income >= 0),
    ADD COLUMN income_tax               bigint NOT NULL DEFAULT 0 CHECK (income_tax >= 0),
    ADD COLUMN other_deductions         bigint NOT NULL DEFAULT 0 CHECK (other_deductions >= 0),
    ADD COLUMN advance_recovery         bigint NOT NULL DEFAULT 0 CHECK (advance_recovery >= 0),
    -- NULL on a pre-0214 line: its `amount` was both gross and net.
    ADD COLUMN net_pay                  bigint CHECK (net_pay IS NULL OR net_pay >= 0);

-- 5. Salary advances --------------------------------------------------------------
CREATE TABLE payroll_advances (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id   uuid REFERENCES locations(id) ON DELETE SET NULL,
    user_id       uuid NOT NULL REFERENCES users(id),
    amount        bigint NOT NULL CHECK (amount > 0),
    method        text NOT NULL CHECK (method IN ('cash', 'bank')),
    advance_date  date NOT NULL DEFAULT CURRENT_DATE,
    note          text CHECK (note IS NULL OR char_length(note) <= 200),
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    voided_at     timestamptz,
    voided_by     uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_payroll_advances_business_user ON payroll_advances (business_id, user_id);

ALTER TABLE payroll_advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_advances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payroll_advances FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
