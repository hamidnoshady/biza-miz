-- GH #1567 F3 — a selling-price markdown is not a write-down.
--
-- Before F3 `applyMarkdown` credited inventory with quantity × (old price −
-- new price): a retail-price difference, not a loss of value. Cost 50,000,
-- price 100,000 → 70,000 on 5 units wrote off 150,000 although the stock was
-- still worth more than it cost. A markdown now changes the price only.
--
-- A write-down is a separate, reviewed act for the items model (every
-- retail-catalogue trade): only when net realisable value per unit is below
-- the carrying value per unit, by a user holding inventory.adjust +
-- ledger.approve, bound to the fingerprint of the state they reviewed. It
-- lowers `item_stock.total_value_rial` (never the quantity) and posts
-- Dr 5170 / Cr the trade's inventory account; later sales relieve the
-- written-down value, so COGS never counts the loss twice. A reversal follows
-- IAS 2: only when NRV recovers, at most the write-down still attributable to
-- units on hand, and never above cost.
--
-- (F&B keeps its allowance-based `inventory_write_downs`, migration 0013+.)

CREATE TABLE IF NOT EXISTS item_nrv_write_downs (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id           uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    item_id               uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    reason                text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
    idempotency_key       text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
    fingerprint           text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    quantity              numeric(18, 9) NOT NULL CHECK (quantity > 0),
    carrying_before_rial  bigint NOT NULL CHECK (carrying_before_rial > 0),
    nrv_unit_rial         bigint NOT NULL CHECK (nrv_unit_rial >= 0),
    amount_rial           bigint NOT NULL CHECK (amount_rial > 0),
    journal_entry_id      uuid REFERENCES journal_entries(id),
    created_by            uuid NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    -- Reversal (at most one): the amount restored and why.
    reversed_amount_rial  bigint CHECK (reversed_amount_rial IS NULL OR (reversed_amount_rial > 0 AND reversed_amount_rial <= amount_rial)),
    reversal_nrv_unit_rial bigint,
    reversal_reason       text,
    reversal_entry_id     uuid REFERENCES journal_entries(id),
    reversed_by           uuid,
    reversed_at           timestamptz,
    CHECK ((reversed_at IS NULL) = (reversed_amount_rial IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_item_nrv_write_downs_idempotency
    ON item_nrv_write_downs (business_id, idempotency_key);
CREATE INDEX IF NOT EXISTS ix_item_nrv_write_downs_item
    ON item_nrv_write_downs (item_id, created_at DESC);

ALTER TABLE item_nrv_write_downs ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_nrv_write_downs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON item_nrv_write_downs;
CREATE POLICY tenant_isolation ON item_nrv_write_downs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
