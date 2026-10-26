-- ============================================================================
-- 0258_wp_source_of_truth.sql — issue #1149: who owns stock and prices.
--
-- `source_of_truth` says which side is authoritative for the stock and price
-- of a connected store's products:
--   store    the store is. The scheduled POS -> store stock/price push is off
--            whatever push_stock / push_prices say.
--   pos      this app is. The two switches decide, exactly as before.
--   two_way  both are edited (the default, and the behaviour every existing
--            connection already had). The two switches decide.
-- The existing rows keep their present behaviour; only an owner's explicit
-- choice of `store` stops the push.
--
-- `manage_stock_opt_in` is the owner's consent for a stock push to *turn on*
-- WooCommerce stock management for a product the store tracks without it. A
-- push to such a product used to send manage_stock = true with whatever
-- quantity this app held — zero, for an item it never stocked — and the
-- storefront went "out of stock" across the catalogue. Off by default.
--
-- No new table, so no RLS change: integration_connections keeps its policy.
-- ============================================================================

ALTER TABLE integration_connections
    ADD COLUMN IF NOT EXISTS source_of_truth text NOT NULL DEFAULT 'two_way',
    ADD COLUMN IF NOT EXISTS manage_stock_opt_in boolean NOT NULL DEFAULT false;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'integration_connections_source_of_truth_check'
    ) THEN
        ALTER TABLE integration_connections
            ADD CONSTRAINT integration_connections_source_of_truth_check
            CHECK (source_of_truth IN ('store', 'pos', 'two_way'));
    END IF;
END $$;
