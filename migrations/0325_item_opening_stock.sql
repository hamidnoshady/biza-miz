-- GH #1567 F2 — opening stock is a reviewed document, not a side effect of
-- creating a product.
--
-- Before F2 the product form's «موجودی اولیه», the Holoo opening-inventory
-- import and the external catalogue import wrote `item_stock.quantity` with no
-- journal entry: the shelf said 10, the inventory account said 0. Catalogue
-- creation now never touches stock. Opening quantities land here as a *draft*
-- (branch, SKU, quantity, unit cost, cutover date, author); a user holding
-- inventory.adjust + ledger.approve reviews the draft and posts it bound to the
-- fingerprint they reviewed. Posting receives the stock and posts
-- Dr inventory / Cr opening equity (3900) in one transaction, exactly once.
--
-- One item can be opened once: `item_opening_stock_postings` is keyed by the
-- item, so a second document (or a concurrent post of the same item) is
-- refused at the database rather than double-counting the opening value.
-- Reversal is not offered: once opened, stock is corrected forward with a
-- stock count, like every other posted document.

CREATE TABLE IF NOT EXISTS item_opening_stock_documents (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
    -- The date the opening balance is effective (the journal entry's date).
    cutover_date      date NOT NULL,
    source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'product_form', 'import')),
    note              text CHECK (note IS NULL OR length(note) <= 500),
    idempotency_key   text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
    created_by        uuid,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    -- Set on posting: the fingerprint the poster reviewed, and the result.
    posted_fingerprint text CHECK (posted_fingerprint IS NULL OR posted_fingerprint ~ '^[0-9a-f]{64}$'),
    posted_by         uuid,
    posted_at         timestamptz,
    journal_entry_id  uuid REFERENCES journal_entries(id),
    total_quantity    numeric(18, 9),
    total_value_rial  bigint,
    cancelled_by      uuid,
    cancelled_at      timestamptz,
    CHECK (status <> 'posted' OR (posted_at IS NOT NULL AND posted_fingerprint IS NOT NULL AND total_value_rial IS NOT NULL)),
    CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_item_opening_stock_documents_idempotency
    ON item_opening_stock_documents (business_id, idempotency_key);
CREATE INDEX IF NOT EXISTS ix_item_opening_stock_documents_location
    ON item_opening_stock_documents (location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS item_opening_stock_lines (
    document_id      uuid NOT NULL REFERENCES item_opening_stock_documents(id) ON DELETE CASCADE,
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    item_id          uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    quantity         numeric(18, 9) NOT NULL CHECK (quantity > 0),
    -- Integer Rial per unit. A draft may hold 0 (an imported row with no
    -- cost); posting refuses it until a reviewer enters the real cost.
    unit_cost        bigint NOT NULL CHECK (unit_cost >= 0),
    PRIMARY KEY (document_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_item_opening_stock_lines_item ON item_opening_stock_lines (item_id);

CREATE TABLE IF NOT EXISTS item_opening_stock_postings (
    item_id          uuid PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    document_id      uuid NOT NULL REFERENCES item_opening_stock_documents(id),
    quantity         numeric(18, 9) NOT NULL,
    value_rial       bigint NOT NULL,
    posted_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_item_opening_stock_postings_business ON item_opening_stock_postings (business_id);

ALTER TABLE item_opening_stock_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_opening_stock_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON item_opening_stock_documents;
CREATE POLICY tenant_isolation ON item_opening_stock_documents FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE item_opening_stock_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_opening_stock_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON item_opening_stock_lines;
CREATE POLICY tenant_isolation ON item_opening_stock_lines FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE item_opening_stock_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_opening_stock_postings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON item_opening_stock_postings;
CREATE POLICY tenant_isolation ON item_opening_stock_postings FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
