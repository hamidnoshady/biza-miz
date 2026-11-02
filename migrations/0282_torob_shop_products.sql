-- ============================================================================
-- 0282_torob_shop_products.sql — issue #894, Wave 4: what a shop publishes.
--
-- Wave 1 decided *which website* may become a shop, Wave 2 built its feed and
-- Wave 3 served and authorized it. What none of them could express is the
-- merchant's own answer to "which products of mine go to Torob" — the
-- `publication_rule` column said `all` or `selected`, but there was nowhere to
-- record a selection, so `selected` meant "nothing".
--
-- This table is that answer, and it is deliberately **thin**: a decision, not a
-- copy. The catalogue stays in `menu_items`; a row here says only "this product
-- is in (or out of) this shop's feed". Copying a name or a price would make a
-- second catalogue that drifts from the first, and Torob would then show a price
-- the storefront no longer charges.
--
-- ## Two decisions, one column
--
-- `decision` is `include` or `exclude`, and the shop's `publication_rule` decides
-- which of them is doing the work:
--
--   rule = 'all'       the catalogue, minus rows marked `exclude`
--   rule = 'selected'  only rows marked `include`
--
-- One table instead of two lists because the two rules are the same question
-- asked from opposite ends ("everything but these" / "only these"). Splitting them
-- would let a shop hold an inclusion list and an exclusion list at once, and then
-- nobody — not the merchant, not the feed, not the screen — could say what it
-- publishes without reading both.
--
-- ## Why the product id is not a foreign key
--
-- `menu_items` is where a WooCommerce or café catalogue lives today, but the feed
-- also has to serve retail `items` (issue #894's variant work). A hard reference to
-- one of them would make the other row impossible to record. The reference is
-- therefore soft, exactly like `torob_shops.source_connection_id`, and the service
-- verifies every id against the tenant's own catalogue before it writes:
-- `setProductDecision` refuses an id the business does not own. The row is removed
-- with the shop (`ON DELETE CASCADE`), so a deleted shop never leaves a selection
-- behind.
--
-- Tenant RLS in this migration, per CLAUDE.md.
-- ============================================================================

CREATE TABLE torob_shop_products (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    shop_id         uuid NOT NULL,
    -- Soft reference to the tenant's catalogue row (menu_items today, retail items
    -- when the variant work lands). Verified against the catalogue on write.
    product_id      uuid NOT NULL,
    decision        text NOT NULL CHECK (decision IN ('include', 'exclude')),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- One decision per product per shop: flipping a product is an UPDATE, never a
    -- second row that the feed would have to disambiguate.
    CONSTRAINT torob_shop_products_one_per_product
        UNIQUE (business_id, shop_id, product_id),
    -- The composite key proves the row can never attach itself to another
    -- business's shop, the same pattern `torob_feed_runs` uses.
    CONSTRAINT torob_shop_products_shop_fk
        FOREIGN KEY (shop_id, business_id)
        REFERENCES torob_shops (id, business_id)
        ON DELETE CASCADE
);

-- The feed reads the whole selection for one shop on every build; the screen
-- reads one page of it. Both are this index.
CREATE INDEX idx_torob_shop_products_shop
    ON torob_shop_products (business_id, shop_id, decision);

ALTER TABLE torob_shop_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE torob_shop_products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON torob_shop_products FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE torob_shop_products IS
    'Issue #894 Wave 4: the merchant''s per-product decision for one Torob shop. A decision, never a copy of the catalogue — names and prices stay in menu_items.';
COMMENT ON COLUMN torob_shop_products.decision IS
    'include: publish this product (the only thing rule=selected publishes). exclude: leave it out (applies under rule=all).';
COMMENT ON COLUMN torob_shop_products.product_id IS
    'Soft reference to the tenant''s catalogue row; verified against the catalogue when written, and removed with the shop.';
