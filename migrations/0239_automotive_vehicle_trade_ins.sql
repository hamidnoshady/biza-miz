-- ============================================================================
-- 0239_automotive_vehicle_trade_ins.sql — issue #963 (the §9 follow-up to
-- #839): the two-sided trade-in link.
--
-- A trade-in is ONE deal with two sides that already exist separately:
--
--   * the sale of vehicle A, whose durable fact is one row of
--     `automotive_vehicle_sales` (0215) over the ordinary retail invoice;
--   * the acquisition of vehicle B, whose durable fact is one
--     `automotive_vehicle_attributes` row (0212) acquired with
--     `source: 'trade_in'` and settled against «تعهد بابت معاوضه خودرو» (2465).
--
-- Nothing about either side is re-modelled here. What this migration adds is
-- the one thing #839 deliberately left for this wave: the auditable link
-- that says *B paid (in part) for A*, with the deal's consideration
-- arithmetic frozen on it — the allowance agreed for B, the part of it that
-- was applied against A's invoice inside the sale's revenue entry, the
-- deposit applied beside it, and the difference the customer still had to
-- settle (in money, or on account). Reports and the audit trail read the
-- link instead of guessing from two timestamps.
--
-- Accounting stays canonical, and this table owns none of it:
--
--   * B's acquisition posts through `automotive.vehicle_acquired`
--     (Debit 1370 / Credit 2465) exactly like any other acquisition — the
--     allowance is B's `purchase_cost_rial`, which is why B's margin is
--     later computed from the allowance like any purchase;
--   * A's sale posts through `automotive.sale_revenue`, whose debits gain
--     one line this wave: the applied part of the allowance *debits* 2465,
--     clearing the obligation the acquisition created — the same shape the
--     reservation deposit's application (clearing 2430) already had. The
--     allowance is part of the consideration, never a discount: it does not
--     reduce A's price, its revenue or its VAT.
--   * an allowance that exceeds what A's invoice can still absorb (after
--     the deposit) stays on 2465 as `remainder_payable_rial` — money the
--     dealership still owes the customer — instead of quietly becoming
--     revenue. The CHECK below makes applied + remainder = allowance, so
--     the link can never lose or invent part of the allowance.
--
-- One trade-in vehicle per deal. Multi-vehicle trade-ins are refused loudly
-- by the service (`multi_trade_in_not_supported`); the unique indexes below
-- (one link per sale occurrence, one *active* link per acquired vehicle)
-- are the structural half of that decision.
--
-- Idempotency lives here too: `client_request_id` is the same submission
-- key the retail invoice carries (`orders.client_request_id`), unique per
-- branch, with a fingerprint of the whole two-sided request — so a retried
-- trade-in answers with the deal already recorded instead of acquiring B a
-- second time while A's "sold once" lock refuses the sale.
--
-- Reversal is a status, never a delete: reversing the deal mirrors A's sale
-- entries through the ordinary vehicle-sale reversal, mirrors B's
-- acquisition entry, and archives B (the customer takes their car back).
-- The link keeps the reason and every mirror entry id. `RESTRICT` on the
-- sale/vehicle references is deliberate: while a link (even a reversed one)
-- names the sale and the cars, none of them may be deleted out from under
-- the audit trail.
--
-- Tenancy: standard FORCE RLS `tenant_isolation` policy. The table is not
-- in `EXEMPT_TABLES`, so it travels with the tenant export/restore like
-- every other tenant table, in FK order after the sale and both vehicles.
-- ============================================================================

CREATE TABLE automotive_vehicle_trade_ins (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id               uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id               uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    -- The sale side: the durable occurrence of A's sale (0215) and the
    -- invoice that carried it.
    sale_id                   uuid NOT NULL REFERENCES automotive_vehicle_sales(sale_id) ON DELETE RESTRICT,
    order_id                  uuid REFERENCES orders(id) ON DELETE SET NULL,
    -- The two physical cars. A is sold by `sale_id`; B was acquired by this
    -- deal. They can never be the same unit.
    sold_serial_id            uuid NOT NULL REFERENCES automotive_vehicle_attributes(serial_id) ON DELETE RESTRICT,
    acquired_serial_id        uuid NOT NULL REFERENCES automotive_vehicle_attributes(serial_id) ON DELETE RESTRICT,
    -- The customer on both sides: they bought A and handed in B.
    customer_id               uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,

    -- The frozen consideration arithmetic (Rial, whole). `allowance_rial`
    -- is B's acquisition cost; `expected_retail_rial` is B's asking price at
    -- hand-in — separate numbers (§5 of the issue), never mixed.
    allowance_rial            bigint NOT NULL CHECK (allowance_rial > 0),
    expected_retail_rial      bigint NOT NULL DEFAULT 0 CHECK (expected_retail_rial >= 0),
    sale_total_rial           bigint NOT NULL CHECK (sale_total_rial >= 0),
    deposit_applied_rial      bigint NOT NULL DEFAULT 0 CHECK (deposit_applied_rial >= 0),
    trade_in_applied_rial     bigint NOT NULL CHECK (trade_in_applied_rial >= 0),
    remainder_payable_rial    bigint NOT NULL DEFAULT 0 CHECK (remainder_payable_rial >= 0),
    difference_due_rial       bigint NOT NULL CHECK (difference_due_rial >= 0),
    -- How the difference settled: a money tender, on the customer's account
    -- (`credit`), or `none` when deposit + allowance covered the invoice.
    difference_settlement     text NOT NULL CHECK (difference_settlement IN ('cash', 'bank', 'credit', 'none')),

    -- B's acquisition ledger entry, so the reversal mirrors the exact entry
    -- the acquisition posted rather than a re-derived twin.
    acquisition_entry_id      uuid,

    status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reversed')),
    reversal_reason           text,
    reversal_entry_ids        uuid[] NOT NULL DEFAULT '{}',
    reversed_by               uuid REFERENCES users(id) ON DELETE SET NULL,
    reversed_at               timestamptz,

    -- The submission key of the whole deal (the invoice carries the same).
    client_request_id         text,
    request_fingerprint       text,

    created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT automotive_trade_in_distinct_vehicles
        CHECK (sold_serial_id <> acquired_serial_id),
    -- Every Rial of the allowance is accounted for: applied against the
    -- invoice, or still owed to the customer on 2465.
    CONSTRAINT automotive_trade_in_allowance_accounted
        CHECK (trade_in_applied_rial + remainder_payable_rial = allowance_rial),
    CONSTRAINT automotive_trade_in_applied_within_invoice
        CHECK (deposit_applied_rial + trade_in_applied_rial + difference_due_rial = sale_total_rial),
    CONSTRAINT automotive_trade_in_difference_settlement_shape
        CHECK ((difference_due_rial = 0) = (difference_settlement = 'none')),
    CONSTRAINT automotive_trade_in_reversal_shape CHECK (
      (status = 'active' AND reversal_reason IS NULL AND reversed_at IS NULL) OR
      (status = 'reversed' AND reversal_reason IS NOT NULL AND length(btrim(reversal_reason)) > 0 AND reversed_at IS NOT NULL)
    )
);

-- One deal per sale occurrence, and at most one live deal per acquired car.
CREATE UNIQUE INDEX uq_automotive_trade_in_sale
    ON automotive_vehicle_trade_ins (sale_id);
CREATE UNIQUE INDEX uq_automotive_trade_in_acquired_active
    ON automotive_vehicle_trade_ins (acquired_serial_id) WHERE status = 'active';
-- The retry identity, scoped exactly like `orders.client_request_id`.
CREATE UNIQUE INDEX uq_automotive_trade_in_client_request
    ON automotive_vehicle_trade_ins (business_id, location_id, client_request_id)
    WHERE client_request_id IS NOT NULL;

CREATE INDEX idx_automotive_trade_ins_sold_vehicle
    ON automotive_vehicle_trade_ins (business_id, sold_serial_id, created_at DESC);
CREATE INDEX idx_automotive_trade_ins_customer
    ON automotive_vehicle_trade_ins (business_id, customer_id, created_at DESC);
CREATE INDEX idx_automotive_trade_ins_business_day
    ON automotive_vehicle_trade_ins (business_id, location_id, created_at DESC);

ALTER TABLE automotive_vehicle_trade_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE automotive_vehicle_trade_ins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automotive_vehicle_trade_ins FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
