-- ============================================================================
-- 0215_payroll_hardening.sql — issue #835: payroll integrity, audit trail and
-- commission settlement, on top of 0214's gross-to-net schema.
--
-- Payroll stays *journal-level* (accrual → payment → void through the shared
-- ledger path); nothing here is a tax/insurance/payslip engine — the rates are
-- the business's own, entered in the settings 0214's run reads. What changes:
--
--   1. Retry-safe accruals. 0214 already gives a run its month (`period_key`,
--      `YYYY-MM`) and makes a second standing run for it impossible
--      (`uq_payroll_runs_period`). This adds the other half: an optional
--      `idempotency_key`, so a network retry of the same request returns the run
--      it created instead of a duplicate or an error.
--
--   2. Employee identity is a snapshot. A line used to carry only `user_id`
--      and its figures, so renaming a member rewrote every historical run and
--      deleting one turned the name into «عضو حذف‌شده». The name, personnel
--      code and role are copied onto the line at accrual time, and the line is
--      immutable afterwards (only the referential `user_id → NULL` may touch it).
--
--   3. Commission is paid with payroll. Commission accrues Debit 5210 / Credit
--      2300 the moment a sale posts, but a run settled only the wage bill, so
--      2300 kept every commission credit for ever. A run now *claims* the
--      commission accruals it settles (`commission_accruals.payroll_run_id`,
--      one column → an accrual can belong to one run at a time, which is the
--      "no double settlement" guarantee), snapshots the per-employee amount on
--      the line (`commission_amount`) and the run total (`commission_total`),
--      and the payment debits 2300 for net wages + commission together. No
--      second accrual entry is posted for commission — it is already in 2300.
--
--   4. Pay-term changes are audited. `payroll_pay_term_changes` is append-only
--      (a trigger refuses UPDATE and DELETE; only the cascade of removing a whole
--      business may delete) and records every change to a member's wage,
--      allowances and fixed deduction: who, when, from what to what, why. It
--      deliberately has no foreign key to `users`: a referential action would be
--      an UPDATE on an immutable row, and the name snapshots make the row
--      readable after a rename or removal anyway.
--
--   5. Payroll is business-wide. A run, its entries and an advance's entry carry
--      no branch. Nothing to migrate: `location_id` stays NULL for everything
--      created from now on, and a legacy row keeps the branch it was stored with.
--
-- Tenant RLS on the one new table, in this migration, per CLAUDE.md.
-- Forward-only: nothing is dropped except the two `> 0` checks that a
-- commission-only run needs relaxed.
-- ============================================================================

-- The backfill below rewrites every tenant's lines.
SELECT set_config('app.rls_bypass', 'on', true);

-- ---------------------------------------------------------------------------
-- 1. payroll_runs — idempotency, commission total
-- ---------------------------------------------------------------------------
ALTER TABLE payroll_runs
    ADD COLUMN idempotency_key  text,
    ADD COLUMN commission_total bigint NOT NULL DEFAULT 0;

ALTER TABLE payroll_runs
    ADD CONSTRAINT payroll_runs_idempotency_key_shape
        CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 128);

-- A run is wages, commission, or both — but never nothing, and never negative.
-- (`total_amount` keeps the meaning 0214 gave it: the GROSS wage bill, the
-- salaries-expense debit. `net_amount` is what the accrual credited to 2300 —
-- NULL on a run from before 0214, whose gross was also its net. Every
-- pre-existing run is wage-only, so its payable amount is unchanged.)
ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_total_amount_check;
ALTER TABLE payroll_runs
    ADD CONSTRAINT payroll_runs_amounts_check
        CHECK (total_amount >= 0 AND commission_total >= 0 AND total_amount + commission_total > 0);

CREATE UNIQUE INDEX uq_payroll_runs_idempotency
    ON payroll_runs (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- The history list is newest-first with a keyset cursor on exactly this tuple.
CREATE INDEX idx_payroll_runs_history
    ON payroll_runs (business_id, accrual_date DESC, created_at DESC, id DESC);

COMMENT ON COLUMN payroll_runs.location_id IS
    'NULL for every run created since issue #835: payroll is business-wide, so the accrual, the payment and the void all post with a NULL location and a branch selector cannot move them. A non-NULL value is a legacy run; its payment and void reuse it instead of the caller''s active branch.';
COMMENT ON COLUMN payroll_runs.total_amount IS
    'The GROSS wage bill of the run (the salaries-expense debit). The amount paid is COALESCE(net_amount, total_amount) + commission_total.';
COMMENT ON COLUMN payroll_runs.commission_total IS
    'Commission accruals this run settles. They were credited to 2300 when the sales posted; the run does not accrue them again, its payment pays them.';

-- ---------------------------------------------------------------------------
-- 2. payroll_run_lines — identity snapshot + commission component
-- ---------------------------------------------------------------------------
ALTER TABLE payroll_run_lines
    ADD COLUMN employee_name_snapshot text,
    ADD COLUMN employee_code_snapshot text,
    ADD COLUMN employee_role_snapshot text,
    ADD COLUMN commission_amount      bigint NOT NULL DEFAULT 0;

ALTER TABLE payroll_run_lines DROP CONSTRAINT IF EXISTS payroll_run_lines_amount_check;
ALTER TABLE payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_amounts_check
        CHECK (amount >= 0 AND commission_amount >= 0 AND amount + commission_amount > 0),
    ADD CONSTRAINT payroll_run_lines_name_snapshot_shape
        CHECK (employee_name_snapshot IS NULL OR char_length(btrim(employee_name_snapshot)) > 0);

-- Best-effort backfill from the member as they are today. A line whose member
-- is already gone (user_id NULL) cannot be recovered and stays NULL; the screen
-- keeps its «عضو حذف‌شده» fallback for exactly those rows.
UPDATE payroll_run_lines l
   SET employee_name_snapshot = u.full_name,
       employee_role_snapshot = u.role::text,
       employee_code_snapshot = e.employee_code
  FROM users u
  LEFT JOIN employees e ON e.id = u.id
 WHERE u.id = l.user_id
   AND l.employee_name_snapshot IS NULL;

-- A line is a snapshot: after insert only the referential user_id → NULL (the
-- member row was deleted) may change it. Compared as whole rows minus user_id,
-- so a column added later — 0214's gross-to-net breakdown included — is
-- immutable the day it appears, with no list here to forget to extend.
-- Created after the backfill above.
CREATE FUNCTION payroll_run_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW) - 'user_id') IS DISTINCT FROM (to_jsonb(OLD) - 'user_id')
       OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL)
    THEN
        RAISE EXCEPTION 'payroll run lines are immutable snapshots'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER trg_payroll_run_lines_guard
    BEFORE UPDATE ON payroll_run_lines
    FOR EACH ROW EXECUTE FUNCTION payroll_run_lines_guard();

-- ---------------------------------------------------------------------------
-- 3. commission_accruals — the settlement link
-- ---------------------------------------------------------------------------
-- NULL = not settled by any run yet. A void clears it again, so the accruals
-- of a voided run are claimable by the next one. ON DELETE SET NULL for the
-- same reason: a run that no longer exists settles nothing.
ALTER TABLE commission_accruals
    ADD COLUMN payroll_run_id uuid REFERENCES payroll_runs(id) ON DELETE SET NULL;

CREATE INDEX idx_commission_accruals_unsettled
    ON commission_accruals (business_id, employee_id)
    WHERE payroll_run_id IS NULL;
CREATE INDEX idx_commission_accruals_run
    ON commission_accruals (payroll_run_id)
    WHERE payroll_run_id IS NOT NULL;

COMMENT ON COLUMN payroll_advances.location_id IS
    'NULL for every advance recorded since issue #835: the run that recovers it is business-wide, so the advance is too. A non-NULL value is an advance recorded before that, and its void mirrors the entry under the same location.';

-- ---------------------------------------------------------------------------
-- 4. payroll_pay_term_changes — the immutable pay-term history
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_pay_term_changes (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id              uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- No foreign keys on the two people: see the header. The name snapshots are
    -- what keeps the row meaningful after a rename or a removal.
    user_id                  uuid NOT NULL,
    employee_name_snapshot   text NOT NULL,
    -- Which standing term changed: the `users` column that holds it.
    term                     text NOT NULL CHECK (term IN (
                                 'monthly_wage', 'monthly_taxable_allowance',
                                 'monthly_non_taxable_allowance', 'monthly_fixed_deduction')),
    -- NULL = "no wage set" on that side of the change; only the wage can be unset.
    previous_amount          bigint CHECK (previous_amount IS NULL OR previous_amount >= 0),
    new_amount               bigint CHECK (new_amount IS NULL OR new_amount >= 0),
    changed_by               uuid,
    changed_by_name_snapshot text,
    -- clock_timestamp(), not now(): the row is written after the member row is
    -- locked, so this orders changes the way they were really applied.
    changed_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    reason                   text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
    CONSTRAINT payroll_pay_term_changes_is_a_change CHECK (previous_amount IS DISTINCT FROM new_amount),
    CONSTRAINT payroll_pay_term_changes_only_the_wage_unsets
        CHECK (term = 'monthly_wage' OR (previous_amount IS NOT NULL AND new_amount IS NOT NULL))
);

CREATE INDEX idx_payroll_pay_term_changes_user
    ON payroll_pay_term_changes (business_id, user_id, changed_at DESC, id DESC);
CREATE INDEX idx_payroll_pay_term_changes_business
    ON payroll_pay_term_changes (business_id, changed_at DESC, id DESC);

-- Append-only. A direct UPDATE/DELETE is refused; the DELETE that Postgres
-- itself runs when a whole business is removed (a referential action, i.e. a
-- trigger nested inside a trigger) is the one permitted exception.
CREATE FUNCTION payroll_pay_term_changes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'payroll pay-term history is append-only'
        USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER trg_payroll_pay_term_changes_guard
    BEFORE UPDATE OR DELETE ON payroll_pay_term_changes
    FOR EACH ROW EXECUTE FUNCTION payroll_pay_term_changes_guard();

ALTER TABLE payroll_pay_term_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_pay_term_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payroll_pay_term_changes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

SELECT set_config('app.rls_bypass', '', true);
