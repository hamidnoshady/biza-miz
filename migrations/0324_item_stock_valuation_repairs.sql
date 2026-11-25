-- GH #1567 F1 — stale inventory valuation: audit trail for authorised repairs.
--
-- Fungible (`tracking='none'`) item stock carries its exact carrying value in
-- `item_stock.total_value_rial` (migration 0236). Before F1, sale, transfer,
-- return, void and reversal paths moved `quantity` without that value, so a
-- pre-existing row can hold a total its quantity and moving average no longer
-- justify. The fixed writers never rewrite that drift silently; they carry it
-- forward and measure new movements against quantity × average.
--
-- Clearing the drift is a separate, explicit act: an operator reviews the
-- dry-run reconciliation, then authorises a repair bound to the exact
-- fingerprint of what they reviewed. Every repair leaves one row here with
-- the before/after value of every line it touched. No journal entry is
-- posted by a repair — the ledger was posted at quantity × average all along;
-- the repair re-aligns the subledger to it.

CREATE TABLE IF NOT EXISTS item_stock_valuation_repairs (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id      uuid REFERENCES locations(id) ON DELETE SET NULL,
    performed_by     uuid NOT NULL,
    reason           text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
    -- The dry-run fingerprint the operator reviewed; a repair whose current
    -- state no longer matches it is refused, so what was reviewed is what runs.
    fingerprint      text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
    line_count       integer NOT NULL CHECK (line_count > 0),
    stored_total     bigint NOT NULL,
    repaired_total   bigint NOT NULL,
    -- [{itemId, quantity, unitCost, before, after}]
    lines            jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_item_stock_valuation_repairs_idempotency
    ON item_stock_valuation_repairs (business_id, idempotency_key);
CREATE INDEX IF NOT EXISTS ix_item_stock_valuation_repairs_business_created
    ON item_stock_valuation_repairs (business_id, created_at DESC);

ALTER TABLE item_stock_valuation_repairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_stock_valuation_repairs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON item_stock_valuation_repairs;
CREATE POLICY tenant_isolation ON item_stock_valuation_repairs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
