-- Issue #869 review — a commission run that has posted money keeps its history.
--
-- The lifecycle (0216 + the service) used to decide whether a run could be
-- rejected or voided from its NET paid total. A payout that was fully reversed
-- left the total at zero, so the run looked untouched: reject then deleted its
-- snapshot lines and released its accruals, while the posted payout and its
-- journal entry kept pointing at a run that no longer held them. Nothing in the
-- database refused it.
--
-- This migration makes the database enforce the rule the service now applies,
-- for every path that could reach those rows (not only the service):
--
--   1. A run that has ever posted a payout document may not return to draft and
--      may not be voided (the run-status guard).
--   2. Its snapshot lines may not be deleted by a reset (the line guard). They
--      still leave with their run when the whole business is deleted, which is a
--      cascade and stays allowed.
--   3. Its accruals keep their claim (the accrual claim guard). Cascades stay
--      allowed for the same reason.
--   4. A payout may only be posted to a run that can still pay (payable or
--      partially paid), and a reversal only to a run that has money out
--      (partially paid or paid). A closed or voided run takes neither.
--
-- Forward-only: this replaces the functions from 0216 and adds one helper, one
-- trigger on commission_accruals and one on the payouts table. No table, column
-- or row is changed, so existing data needs no backfill.

-- ---------------------------------------------------------------------------
-- 0. The one question every guard asks: has this run ever posted a payout?
-- ---------------------------------------------------------------------------
CREATE FUNCTION commission_run_has_payouts(p_run_id uuid) RETURNS boolean
    LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM commission_settlement_payouts
         WHERE run_id = p_run_id AND kind = 'payout'
    )
$$;

-- ---------------------------------------------------------------------------
-- 1. Run guard: identity stays fixed, and posted history cannot be undone
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION commission_settlement_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF pg_trigger_depth() > 1 THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'commission settlement runs are kept for audit; void the run instead'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.business_id IS DISTINCT FROM OLD.business_id
       OR NEW.run_number IS DISTINCT FROM OLD.run_number
       OR NEW.period_from IS DISTINCT FROM OLD.period_from
       OR NEW.period_to IS DISTINCT FROM OLD.period_to
       OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.employee_filter IS DISTINCT FROM OLD.employee_filter
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'commission settlement run identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NEW.status IN ('draft', 'voided')
       AND commission_run_has_payouts(OLD.id) THEN
        RAISE EXCEPTION 'commission run % has posted payouts and cannot return to draft or be voided', OLD.run_number
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Line guard: a reset may purge a snapshot only while nothing was posted
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION commission_settlement_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- A business or run cascade (trigger depth > 1) removes the snapshot with
    -- its owner; that is deletion of the whole record, not an edit of it.
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    IF TG_OP = 'DELETE'
       AND coalesce(current_setting('app.commission_settlement_reset', true), '') = 'on'
       AND NOT commission_run_has_payouts(OLD.run_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'commission settlement lines are an immutable snapshot'
        USING ERRCODE = '55000';
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Accrual claim guard: a claim backed by posted money is not released
-- ---------------------------------------------------------------------------
CREATE FUNCTION commission_accruals_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF OLD.settlement_run_id IS NOT NULL
       AND NEW.settlement_run_id IS DISTINCT FROM OLD.settlement_run_id
       AND commission_run_has_payouts(OLD.settlement_run_id) THEN
        RAISE EXCEPTION 'an accrual claimed by a commission run with posted payouts cannot be released'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_commission_accruals_claim_guard
    BEFORE UPDATE OF settlement_run_id ON commission_accruals
    FOR EACH ROW EXECUTE FUNCTION commission_accruals_claim_guard();

-- ---------------------------------------------------------------------------
-- 4. Payout guard: money moves only while the run can take it
-- ---------------------------------------------------------------------------
CREATE FUNCTION commission_settlement_payouts_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_status text;
BEGIN
    SELECT status INTO v_status FROM commission_settlement_runs WHERE id = NEW.run_id;
    IF NEW.kind = 'payout' AND v_status NOT IN ('payable', 'partially_paid') THEN
        RAISE EXCEPTION 'a payout can only be posted to a payable run (run is %)', v_status
            USING ERRCODE = '55000';
    END IF;
    IF NEW.kind = 'reversal' AND v_status NOT IN ('partially_paid', 'paid') THEN
        RAISE EXCEPTION 'a payout can only be reversed while its run has money out (run is %)', v_status
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_commission_settlement_payouts_insert_guard
    BEFORE INSERT ON commission_settlement_payouts
    FOR EACH ROW EXECUTE FUNCTION commission_settlement_payouts_insert_guard();
