-- #915: request identity is committed with stock, posting and integration outbox.
-- Existing/imported documents may have no request key; public APIs require one.
CREATE TABLE retail_stock_requests (
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    operation text NOT NULL CHECK (operation IN ('purchase', 'supplier_return')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    payload_hash text NOT NULL,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, operation, idempotency_key)
);
ALTER TABLE retail_stock_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE retail_stock_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON retail_stock_requests FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- A manufacturer's lot may merge multiple receipts; store exact acquisition
-- links separately. Never guess provenance for historic multi-unit serials.
ALTER TABLE item_purchase_items ADD COLUMN batch_id uuid REFERENCES item_batches(id) ON DELETE RESTRICT;
CREATE TABLE item_purchase_serials (
    purchase_item_id uuid NOT NULL REFERENCES item_purchase_items(id) ON DELETE CASCADE,
    serial_id uuid NOT NULL UNIQUE REFERENCES item_serials(id) ON DELETE RESTRICT,
    PRIMARY KEY (purchase_item_id, serial_id)
);
INSERT INTO item_purchase_serials (purchase_item_id, serial_id)
    SELECT id, serial_id FROM item_purchase_items WHERE serial_id IS NOT NULL;
ALTER TABLE item_purchase_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_purchase_serials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_purchase_serials FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_purchase_items pi JOIN item_purchases p ON p.id=pi.purchase_id
         WHERE pi.id=purchase_item_id AND p.business_id=app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_purchase_items pi JOIN item_purchases p ON p.id=pi.purchase_id
         WHERE pi.id=purchase_item_id AND p.business_id=app_current_business()));
ALTER TABLE item_supplier_return_items ADD COLUMN purchase_item_id uuid REFERENCES item_purchase_items(id) ON DELETE RESTRICT;
ALTER TABLE item_purchases ADD COLUMN settlement_method text NOT NULL DEFAULT 'credit'
    CHECK (settlement_method IN ('cash', 'bank', 'credit'));
