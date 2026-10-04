-- Retail + Cosmetics (issue #770) — exact batch allocation persistence.
--
-- A `tracking='batch'` sale consumes specific `item_batches` rows through FEFO
-- (src/lib/fefo.ts), but until now only the batch *numbers* survived on the
-- invoice snapshot — not which rows were relieved, nor how much of each. That
-- made an exact reversal impossible: restoring `item_stock.quantity` alone
-- would have broken the migration-0078 invariant ("item_stock is the
-- authoritative SUM of item_batches"), which is why
-- `retail-invoice-void-service.ts` used to refuse batch cosmetics outright.
--
-- These three tables are the missing record:
--
--   order_item_batch_allocations  — what each sold line actually consumed,
--     one row per (order item, batch). Authoritative for COGS reconstruction,
--     returns/refunds, voids/reversals, recall lookup and audit.
--
--   order_item_batch_restorations — what came back, and how it was disposed.
--     `restockable` goes back into the *original* batch (so the lot's own
--     expiry still governs it); damaged/expired/quarantine/tester/do-not-restock
--     are recorded here without putting sellable stock back on the shelf.
--
--   item_stock_transfer_line_batches — the same idea for branch transfers: a
--     batch keeps its identity, number, expiry and cost across the move.
--
-- Additive and backward compatible: every table is new, and the two columns
-- added to existing tables are nullable, so historical rows and historical
-- invoices (which have no allocations) stay readable and are treated as
-- legacy by the services rather than having allocations invented for them.
--
-- RLS in the same migration, per repo convention: allocations and restorations
-- are scoped through their own `location_id` (app_owns_location), the transfer
-- line rows through their parent transfer's business_id.

-- --------------------------------------------------------------------------
-- Purchase receiving: the real manufacturer/supplier lot, kept as data.
-- --------------------------------------------------------------------------
-- `item_batches` carried only a batch number, expiry and supplier reference;
-- a purchase receipt invented an internal `P-…` number and stored nothing
-- about the real lot. The real lot number now lives on the purchase line and
-- reaches the batch through `receiveBatch`, with the internal reference kept
-- in `item_batches.supplier_reference` rather than replacing it.
ALTER TABLE item_batches ADD COLUMN IF NOT EXISTS manufacture_date date;

ALTER TABLE item_purchase_items
    ADD COLUMN IF NOT EXISTS batch_number  text,
    ADD COLUMN IF NOT EXISTS manufacture_date date,
    ADD COLUMN IF NOT EXISTS expiry_date   date,
    ADD COLUMN IF NOT EXISTS supplier_reference text,
    -- True when the receipt had no real lot number and the service generated
    -- one for traceability. Visible so a report can tell a real lot from a
    -- generated reference.
    ADD COLUMN IF NOT EXISTS internal_batch_number boolean NOT NULL DEFAULT false;

-- --------------------------------------------------------------------------
-- Exact allocation of a sold order line across batches.
-- --------------------------------------------------------------------------
CREATE TABLE order_item_batch_allocations (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_item_id  uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    -- Denormalised for RLS and for recall queries that start from an order.
    order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    location_id    uuid NOT NULL REFERENCES locations(id),
    item_id        uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    -- SET NULL rather than CASCADE: deleting a batch row must never delete the
    -- audit record of what that batch was worth to a completed sale. The
    -- snapshot columns below stay readable either way.
    batch_id       uuid REFERENCES item_batches(id) ON DELETE SET NULL,
    -- Snapshot at consumption time — the number printed on the receipt, the
    -- expiry the sale was governed by, and the exact cost relieved.
    batch_number   text NOT NULL,
    expiry_date    date,
    quantity       numeric(24, 9) NOT NULL CHECK (quantity > 0),
    unit_cost      bigint CHECK (unit_cost IS NULL OR unit_cost >= 0),
    cost_value     bigint NOT NULL CHECK (cost_value >= 0),
    -- How much of `quantity` has been returned to stock, and how much was
    -- disposed of without returning (damaged/expired/quarantine/tester/…).
    -- quantity - restored_quantity - disposed_quantity is the line's still-open
    -- batch quantity, which is what makes a second refund call idempotent.
    restored_quantity numeric(24, 9) NOT NULL DEFAULT 0
        CHECK (restored_quantity >= 0 AND restored_quantity <= quantity),
    disposed_quantity numeric(24, 9) NOT NULL DEFAULT 0
        CHECK (disposed_quantity >= 0 AND restored_quantity + disposed_quantity <= quantity),
    -- Which channel consumed it (retail_invoice / woocommerce_order /
    -- cms_store_order / warehouse_issue), for traceability.
    source_type    text NOT NULL,
    source_id      text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_item_batch_allocations_line ON order_item_batch_allocations (order_item_id);
CREATE INDEX idx_order_item_batch_allocations_order ON order_item_batch_allocations (order_id);
CREATE INDEX idx_order_item_batch_allocations_batch ON order_item_batch_allocations (batch_id);
-- Recall lookup: "which customers bought lot X?" — tenant + item + batch.
CREATE INDEX idx_order_item_batch_allocations_recall
    ON order_item_batch_allocations (location_id, item_id, batch_number);

ALTER TABLE order_item_batch_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_batch_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_item_batch_allocations FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

-- --------------------------------------------------------------------------
-- What came back, and how it was disposed of.
-- --------------------------------------------------------------------------
CREATE TABLE order_item_batch_restorations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    allocation_id uuid NOT NULL REFERENCES order_item_batch_allocations(id) ON DELETE CASCADE,
    order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    location_id   uuid NOT NULL REFERENCES locations(id),
    item_id       uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    batch_id      uuid REFERENCES item_batches(id) ON DELETE SET NULL,
    batch_number  text NOT NULL,
    quantity      numeric(24, 9) NOT NULL CHECK (quantity > 0),
    -- restockable | damaged | expired | quarantine | tester | no_restock
    disposition   text NOT NULL CHECK (disposition IN
        ('restockable', 'damaged', 'expired', 'quarantine', 'tester', 'no_restock')),
    -- The cost value put back into inventory (0 for anything not restocked).
    value_rial    bigint NOT NULL DEFAULT 0 CHECK (value_rial >= 0),
    source_type   text NOT NULL,
    source_id     text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_item_batch_restorations_allocation ON order_item_batch_restorations (allocation_id);
CREATE INDEX idx_order_item_batch_restorations_line ON order_item_batch_restorations (order_item_id);
-- One refund delivery, one restoration per allocation: a replayed webhook can
-- therefore never double-restock the same batch quantity.
CREATE UNIQUE INDEX uq_order_item_batch_restoration_source
    ON order_item_batch_restorations (allocation_id, source_type, source_id);

ALTER TABLE order_item_batch_restorations ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_batch_restorations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_item_batch_restorations FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

-- --------------------------------------------------------------------------
-- Batch identity across a branch transfer.
-- --------------------------------------------------------------------------
-- A transfer line may name the exact lot to move (a shop sending a specific
-- batch), otherwise the shipment takes FEFO across the source item's lots.
ALTER TABLE item_stock_transfer_items
    ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES item_batches(id) ON DELETE SET NULL;

CREATE TABLE item_stock_transfer_line_batches (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_line_id uuid NOT NULL REFERENCES item_stock_transfer_items(id) ON DELETE CASCADE,
    -- The source batch this quantity left; SET NULL so history survives a
    -- batch row being merged away at the destination.
    batch_id        uuid REFERENCES item_batches(id) ON DELETE SET NULL,
    batch_number    text NOT NULL,
    expiry_date     date,
    quantity        numeric(24, 9) NOT NULL CHECK (quantity > 0),
    unit_cost       bigint CHECK (unit_cost IS NULL OR unit_cost >= 0),
    value_rial      bigint NOT NULL DEFAULT 0 CHECK (value_rial >= 0),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_item_stock_transfer_line_batches_line ON item_stock_transfer_line_batches (transfer_line_id);
CREATE INDEX idx_item_stock_transfer_line_batches_batch ON item_stock_transfer_line_batches (batch_id);

ALTER TABLE item_stock_transfer_line_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_stock_transfer_line_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_stock_transfer_line_batches FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_stock_transfer_items li
          JOIN item_stock_transfers t ON t.id = li.transfer_id
         WHERE li.id = item_stock_transfer_line_batches.transfer_line_id
           AND (app_rls_bypass() OR t.business_id = app_current_business())))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_stock_transfer_items li
          JOIN item_stock_transfers t ON t.id = li.transfer_id
         WHERE li.id = item_stock_transfer_line_batches.transfer_line_id
           AND (app_rls_bypass() OR t.business_id = app_current_business())));
