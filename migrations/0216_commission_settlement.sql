-- Issue #869 — commission run approval, settlement and payout lifecycle.
--
-- Commission accrues per sale line (0083) and is already a payroll liability
-- (0215 settles it inside a payroll run). This migration adds the *other*
-- way to settle it: a standalone settlement run that groups unclaimed accruals
-- into an immutable snapshot, goes through review and approval, and is then
-- paid out in one or more payouts against the same 2300 liability.
--
-- The model, in six tables plus one column:
--
--   commission_settlement_runs      the run: period, filters, status, totals.
--                                   Its identity (number, period, filters,
--                                   creator) never changes; its status and
--                                   totals move along the lifecycle.
--   commission_settlement_lines     the snapshot: one row per accrual (or per
--                                   carried-forward balance) a run includes.
--                                   Names, rule terms, source sale and journal
--                                   entry are copied in, so history survives a
--                                   rule change, a renamed member or a deleted
--                                   user. Immutable once written.
--   commission_settlement_carries   what a partially paid run leaves owing per
--                                   member when it is closed. The next run
--                                   that calculates for that member claims it.
--   commission_settlement_payouts   money-out documents (kind payout) and their
--                                   reversals (kind reversal, which points at
--                                   the payout it undoes). Append-only.
--   commission_settlement_allocations  per payout × member amounts, signed:
--                                   a reversal writes the negated amounts.
--                                   Outstanding is derived from these.
--   commission_settlement_events    the audit trail of run actions (create,
--                                   calculate, review, approve, reject,
--                                   release, payout, reversal, close, void).
--
-- One claim column links accruals to whichever process settled them:
-- `commission_accruals.settlement_run_id`. A CHECK forbids an accrual being
-- claimed by a payroll run and a settlement run at the same time, and every
-- claim path (payroll and standalone) takes the same per-business lock and
-- requires the other claim to be NULL. So "never settle an accrual twice" is
-- enforced by the database, not only by the service.
--
-- Actor and member ids on the snapshot tables are plain uuids, deliberately
-- *not* foreign keys: deleting a user must never rewrite a settlement record,
-- and the immutability guards below would refuse the rewrite anyway.

-- ---------------------------------------------------------------------------
-- 1. Runs
-- ---------------------------------------------------------------------------
CREATE TABLE commission_settlement_runs (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Per-business sequence, shown as «دورهٔ پورسانت شماره …».
    run_number         integer NOT NULL CHECK (run_number > 0),
    title              text CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 120),
    -- Inclusive calendar window (Gregorian storage; Shamsi on screen).
    period_from        date NOT NULL,
    period_to          date NOT NULL,
    -- Branch filter (NULL = every branch). Not a foreign key on purpose: the
    -- run is a snapshot of what was asked, and the guard below keeps it fixed.
    location_id        uuid,
    -- Member filter (empty = every member with unclaimed commission).
    employee_filter    uuid[] NOT NULL DEFAULT '{}',
    status             text NOT NULL DEFAULT 'draft' CHECK (status IN (
                         'draft', 'calculated', 'reviewed', 'approved', 'payable',
                         'partially_paid', 'paid', 'closed', 'voided')),
    line_count         integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
    employee_count     integer NOT NULL DEFAULT 0 CHECK (employee_count >= 0),
    -- Σ of the lines: what the run owes in total (integer Rial, signed lines
    -- net per member, so this is never negative).
    commission_total   bigint NOT NULL DEFAULT 0 CHECK (commission_total >= 0),
    -- Σ of the allocations, net of reversals.
    paid_total         bigint NOT NULL DEFAULT 0 CHECK (paid_total >= 0),
    -- Calculation findings (blocked members, rows held back, …) as codes.
    warnings           jsonb NOT NULL DEFAULT '[]'::jsonb,
    idempotency_key    text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 128),
    -- Actor snapshots (no foreign keys; see the header).
    created_by         uuid,
    created_at         timestamptz NOT NULL DEFAULT now(),
    calculated_by      uuid,
    calculated_at      timestamptz,
    reviewed_by        uuid,
    reviewed_at        timestamptz,
    approved_by        uuid,
    approved_at        timestamptz,
    released_by        uuid,
    released_at        timestamptz,
    paid_at            timestamptz,
    closed_by          uuid,
    closed_at          timestamptz,
    voided_by          uuid,
    voided_at          timestamptz,
    void_reason        text CHECK (void_reason IS NULL OR char_length(void_reason) <= 500),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT commission_settlement_runs_period_order CHECK (period_from <= period_to),
    CONSTRAINT commission_settlement_runs_paid_within_total CHECK (paid_total <= commission_total),
    CONSTRAINT commission_settlement_runs_closed_stamp CHECK (status <> 'closed' OR closed_at IS NOT NULL),
    CONSTRAINT commission_settlement_runs_voided_stamp CHECK (status <> 'voided' OR voided_at IS NOT NULL)
);

CREATE UNIQUE INDEX uq_commission_settlement_runs_number
    ON commission_settlement_runs (business_id, run_number);
CREATE UNIQUE INDEX uq_commission_settlement_runs_idempotency
    ON commission_settlement_runs (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_commission_settlement_runs_status
    ON commission_settlement_runs (business_id, status, created_at DESC);

-- A run's identity is fixed at creation. Only the lifecycle columns move.
CREATE FUNCTION commission_settlement_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    RETURN NEW;
END
$$;
CREATE TRIGGER trg_commission_settlement_runs_guard
    BEFORE UPDATE OR DELETE ON commission_settlement_runs
    FOR EACH ROW EXECUTE FUNCTION commission_settlement_runs_guard();

-- ---------------------------------------------------------------------------
-- 2. Lines — the immutable snapshot of what a run settles
-- ---------------------------------------------------------------------------
CREATE TABLE commission_settlement_lines (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    run_id                uuid NOT NULL REFERENCES commission_settlement_runs(id) ON DELETE CASCADE,
    ordinal               integer NOT NULL CHECK (ordinal > 0),
    -- 'accrual': one commission_accruals row. 'carry_forward': a balance a
    -- closed run left owing (carry_id names the carry row it came from).
    line_kind             text NOT NULL CHECK (line_kind IN ('accrual', 'carry_forward')),
    accrual_id            uuid,
    carry_id              uuid,
    carried_from_run_id   uuid,
    -- Member snapshot.
    employee_id           uuid NOT NULL,
    employee_name         text NOT NULL,
    employee_code         text,
    employee_role         text,
    employee_active       boolean NOT NULL DEFAULT true,
    -- Rule snapshot. commission_rules has no version column, so rule_version
    -- is a hash of the terms that decided the amount: a later edit to the
    -- rule changes the hash of the next run, never this one.
    rule_id               uuid,
    rule_version          text,
    rule_terms            jsonb,
    -- Source sale snapshot.
    source_type           text NOT NULL,
    source_id             uuid,
    source_label          text NOT NULL DEFAULT '',
    source_order_number   text,
    source_item_name      text,
    location_id           uuid,
    sale_date             date,
    entry_id              uuid,
    basis_amount          bigint NOT NULL DEFAULT 0,
    -- Signed: a reversal (sale return, voided invoice) is a negative line.
    amount                bigint NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT commission_settlement_lines_shape CHECK (
        (line_kind = 'accrual' AND accrual_id IS NOT NULL AND carry_id IS NULL AND carried_from_run_id IS NULL AND sale_date IS NOT NULL)
        OR (line_kind = 'carry_forward' AND accrual_id IS NULL AND carry_id IS NOT NULL AND carried_from_run_id IS NOT NULL AND amount > 0)
    )
);

CREATE UNIQUE INDEX uq_commission_settlement_lines_ordinal
    ON commission_settlement_lines (run_id, ordinal);
CREATE UNIQUE INDEX uq_commission_settlement_lines_accrual
    ON commission_settlement_lines (run_id, accrual_id)
    WHERE accrual_id IS NOT NULL;
CREATE INDEX idx_commission_settlement_lines_employee
    ON commission_settlement_lines (run_id, employee_id);
CREATE INDEX idx_commission_settlement_lines_accrual
    ON commission_settlement_lines (accrual_id)
    WHERE accrual_id IS NOT NULL;

-- Lines are never edited. They leave only with their run (a cascade) or when
-- a run is reset to draft by a reject, which sets the transaction-local flag
-- below and nothing else can.
CREATE FUNCTION commission_settlement_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND (
        pg_trigger_depth() > 1
        OR coalesce(current_setting('app.commission_settlement_reset', true), '') = 'on'
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'commission settlement lines are an immutable snapshot'
        USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER trg_commission_settlement_lines_guard
    BEFORE UPDATE OR DELETE ON commission_settlement_lines
    FOR EACH ROW EXECUTE FUNCTION commission_settlement_lines_guard();

-- ---------------------------------------------------------------------------
-- 3. Carries — balances a closed run leaves owing
-- ---------------------------------------------------------------------------
CREATE TABLE commission_settlement_carries (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    from_run_id            uuid NOT NULL REFERENCES commission_settlement_runs(id) ON DELETE CASCADE,
    employee_id            uuid NOT NULL,
    employee_name          text NOT NULL,
    amount                 bigint NOT NULL CHECK (amount > 0),
    -- The run that took this balance into its own lines. NULL = still open.
    claimed_by_run_id      uuid REFERENCES commission_settlement_runs(id) ON DELETE SET NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_commission_settlement_carries_member UNIQUE (from_run_id, employee_id)
);

CREATE INDEX idx_commission_settlement_carries_open
    ON commission_settlement_carries (business_id, employee_id)
    WHERE claimed_by_run_id IS NULL;
CREATE INDEX idx_commission_settlement_carries_claimed
    ON commission_settlement_carries (claimed_by_run_id)
    WHERE claimed_by_run_id IS NOT NULL;

-- Only the claim moves. The amount and the run it came from are fixed.
CREATE FUNCTION commission_settlement_carries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF pg_trigger_depth() > 1 THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'commission carry-forwards are kept for audit'
            USING ERRCODE = '55000';
    END IF;
    IF (to_jsonb(NEW) - 'claimed_by_run_id') IS DISTINCT FROM (to_jsonb(OLD) - 'claimed_by_run_id') THEN
        RAISE EXCEPTION 'commission carry-forward amounts are immutable'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER trg_commission_settlement_carries_guard
    BEFORE UPDATE OR DELETE ON commission_settlement_carries
    FOR EACH ROW EXECUTE FUNCTION commission_settlement_carries_guard();

-- ---------------------------------------------------------------------------
-- 4. Payouts — money-out documents and their reversals (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE commission_settlement_payouts (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    run_id                uuid NOT NULL REFERENCES commission_settlement_runs(id) ON DELETE CASCADE,
    kind                  text NOT NULL CHECK (kind IN ('payout', 'reversal')),
    reverses_payout_id    uuid REFERENCES commission_settlement_payouts(id) ON DELETE CASCADE,
    -- Always positive; the direction is in `kind` and in the allocations.
    amount                bigint NOT NULL CHECK (amount > 0),
    payment_account_id    uuid NOT NULL REFERENCES accounts(id),
    payment_method        text NOT NULL CHECK (payment_method IN ('cash', 'bank')),
    paid_date             date NOT NULL,
    memo                  text CHECK (memo IS NULL OR char_length(memo) <= 500),
    idempotency_key       text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 128),
    request_hash          text,
    -- The journal entry this document posted (no foreign key: entries are
    -- reversed, never deleted, and the mirror is a separate entry).
    entry_id              uuid,
    created_by            uuid,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT commission_settlement_payouts_shape CHECK (
        (kind = 'payout' AND reverses_payout_id IS NULL)
        OR (kind = 'reversal' AND reverses_payout_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_commission_settlement_payouts_idempotency
    ON commission_settlement_payouts (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_commission_settlement_payouts_reversal
    ON commission_settlement_payouts (reverses_payout_id)
    WHERE reverses_payout_id IS NOT NULL;
CREATE INDEX idx_commission_settlement_payouts_run
    ON commission_settlement_payouts (run_id, created_at);

-- ---------------------------------------------------------------------------
-- 5. Allocations — per payout × member, signed
-- ---------------------------------------------------------------------------
CREATE TABLE commission_settlement_allocations (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    payout_id               uuid NOT NULL REFERENCES commission_settlement_payouts(id) ON DELETE CASCADE,
    run_id                  uuid NOT NULL REFERENCES commission_settlement_runs(id) ON DELETE CASCADE,
    employee_id             uuid NOT NULL,
    employee_name           text NOT NULL,
    -- Positive for a payout, negative for its reversal.
    amount                  bigint NOT NULL CHECK (amount <> 0),
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_commission_settlement_allocations_run
    ON commission_settlement_allocations (run_id, employee_id);
CREATE INDEX idx_commission_settlement_allocations_payout
    ON commission_settlement_allocations (payout_id);

-- ---------------------------------------------------------------------------
-- 6. Events — the run's audit trail (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE commission_settlement_events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    run_id              uuid NOT NULL REFERENCES commission_settlement_runs(id) ON DELETE CASCADE,
    action              text NOT NULL CHECK (action IN (
                          'create', 'calculate', 'review', 'approve', 'reject',
                          'release', 'payout', 'payout_reversal', 'close', 'void')),
    from_status         text,
    to_status           text NOT NULL,
    payout_id           uuid REFERENCES commission_settlement_payouts(id) ON DELETE CASCADE,
    actor_id            uuid,
    actor_name          text,
    note                text CHECK (note IS NULL OR char_length(note) <= 500),
    details             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_commission_settlement_events_run
    ON commission_settlement_events (run_id, created_at);

-- Payouts, allocations and events are history: never updated, removed only
-- with their business or run.
CREATE FUNCTION commission_settlement_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
        USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER trg_commission_settlement_payouts_append_only
    BEFORE UPDATE OR DELETE ON commission_settlement_payouts
    FOR EACH ROW EXECUTE FUNCTION commission_settlement_append_only();
CREATE TRIGGER trg_commission_settlement_allocations_append_only
    BEFORE UPDATE OR DELETE ON commission_settlement_allocations
    FOR EACH ROW EXECUTE FUNCTION commission_settlement_append_only();
CREATE TRIGGER trg_commission_settlement_events_append_only
    BEFORE UPDATE OR DELETE ON commission_settlement_events
    FOR EACH ROW EXECUTE FUNCTION commission_settlement_append_only();

-- ---------------------------------------------------------------------------
-- 7. The shared claim on commission accruals
-- ---------------------------------------------------------------------------
ALTER TABLE commission_accruals
    ADD COLUMN settlement_run_id uuid REFERENCES commission_settlement_runs(id) ON DELETE SET NULL;

-- An accrual is settled by at most one process, ever.
ALTER TABLE commission_accruals
    ADD CONSTRAINT commission_accruals_one_claim
    CHECK (payroll_run_id IS NULL OR settlement_run_id IS NULL);

CREATE INDEX idx_commission_accruals_settlement_run
    ON commission_accruals (settlement_run_id)
    WHERE settlement_run_id IS NOT NULL;
CREATE INDEX idx_commission_accruals_unclaimed
    ON commission_accruals (business_id, employee_id)
    WHERE payroll_run_id IS NULL AND settlement_run_id IS NULL;

-- ---------------------------------------------------------------------------
-- 8. Tenant isolation — every new table, in this migration
-- ---------------------------------------------------------------------------
ALTER TABLE commission_settlement_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_settlement_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commission_settlement_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE commission_settlement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_settlement_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commission_settlement_lines FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE commission_settlement_carries ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_settlement_carries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commission_settlement_carries FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE commission_settlement_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_settlement_payouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commission_settlement_payouts FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE commission_settlement_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_settlement_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commission_settlement_allocations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE commission_settlement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_settlement_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commission_settlement_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
