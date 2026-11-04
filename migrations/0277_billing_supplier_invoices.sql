-- Issue #902 §9 item 3 (last part) — the supplier's invoice, checked against ours.
--
-- §5m made a rating cite the price that produced it; §5n turned those ratings
-- into invoice lines, so the **retail** side is now checkable end to end (what a
-- business is billed, at which price version, from which ratings).
--
-- The **wholesale** side has been recorded since §6a: `billing_vendor_cost_events`
-- holds what the provider charged us per send, tenant-invisible. What was missing
-- is the other half of a reconciliation — *the supplier's own statement*. Nobody
-- could answer "the provider invoiced us X for March; do our records agree?", so
-- a supplier over-charge would have been invisible, and so would our own
-- under-recording.
--
-- This table is that statement, plus the verdict of comparing it with our ledger:
--
--   * `claimed_rial`   — what the supplier says we owe for the period;
--   * `recorded_rial`  — what our own events sum to for the same window;
--   * `delta_rial`     — the difference, kept with its sign rather than rounded
--                        away, so the operator knows which way to look;
--   * `state`          — `open` (not compared yet), `matched` (inside the
--                        tolerance), `disputed` (outside it), `accepted`
--                        (a human decided to pay it anyway, with a reason).
--
-- Two invariants worth stating because they are the point of the table:
--
--   1. **Reconciling never edits the evidence.** `billing_vendor_cost_events` is
--      not touched by any of this — not to add a missing row, not to correct an
--      amount. A statement that disagrees with the ledger is a finding, and a
--      ledger adjusted to fit an invoice can no longer test the next one.
--   2. **Accepting a discrepancy requires a reason.** Moving a disputed statement
--      to `accepted` without a note is refused by the CHECK below, because "we
--      paid it anyway" is exactly the decision that needs to be legible a year
--      later.
--
-- Platform-only: this table names the supplier, the wholesale amounts and the
-- margin between them. DoD #3 forbids any of that on a tenant surface, so the
-- policy is the bypass-only form `0262` uses for the retail price catalogue.

CREATE TABLE billing_supplier_invoices (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The supplier this statement came from: 'kavenegar', 'smtp', … matched
    -- against `billing_vendor_cost_events.provider`.
    provider            text NOT NULL CHECK (length(trim(provider)) > 0),
    -- The supplier's own invoice/reference number. Unique per provider: the same
    -- statement recorded twice is the same statement, not a second debt.
    statement_reference text NOT NULL CHECK (length(trim(statement_reference)) > 0),
    -- Half-open window [period_start, period_end), like every other billing window.
    period_start        timestamptz NOT NULL,
    period_end          timestamptz NOT NULL,
    claimed_rial        bigint NOT NULL CHECK (claimed_rial >= 0),
    currency            text NOT NULL DEFAULT 'IRR' CHECK (currency IN ('IRR', 'IRT')),
    -- The verdict of the last reconciliation. NULL until one has run.
    recorded_rial       bigint CHECK (recorded_rial IS NULL OR recorded_rial >= 0),
    recorded_events     integer CHECK (recorded_events IS NULL OR recorded_events >= 0),
    delta_rial          bigint,
    tolerance_rial      bigint CHECK (tolerance_rial IS NULL OR tolerance_rial >= 0),
    state               text NOT NULL DEFAULT 'open'
                            CHECK (state IN ('open', 'matched', 'disputed', 'accepted')),
    -- Why a disputed statement was accepted. Required for `accepted`, refused
    -- for `open` (a statement nobody has compared cannot be explained yet).
    accepted_reason     text,
    note                text,
    reconciled_at       timestamptz,
    reconciled_by       uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    accepted_by         uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    accepted_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, statement_reference),
    CHECK (period_end > period_start),
    -- A verdict requires the comparison it came from.
    CHECK (state = 'open' OR (recorded_rial IS NOT NULL AND delta_rial IS NOT NULL)),
    -- Accepting a discrepancy is a decision, and a decision needs a reason.
    CHECK (state <> 'accepted' OR length(trim(coalesce(accepted_reason, ''))) > 0)
);

CREATE INDEX idx_billing_supplier_invoices_period
    ON billing_supplier_invoices (provider, period_end DESC);
CREATE INDEX idx_billing_supplier_invoices_open
    ON billing_supplier_invoices (state, period_end DESC)
    WHERE state IN ('open', 'disputed');

COMMENT ON TABLE billing_supplier_invoices IS
    'Issue #902 §9 item 3: the supplier''s own statement for a period, reconciled against billing_vendor_cost_events. Wholesale data — platform only.';
COMMENT ON COLUMN billing_supplier_invoices.delta_rial IS
    'claimed_rial - recorded_rial, sign kept. Positive = the supplier wants more than we recorded.';
COMMENT ON COLUMN billing_supplier_invoices.accepted_reason IS
    'Required to accept a disputed statement: paying a difference is a decision, and it has to be legible later.';

ALTER TABLE billing_supplier_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_supplier_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON billing_supplier_invoices FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());
