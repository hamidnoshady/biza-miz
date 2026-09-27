-- ============================================================================
-- 0181_cms_store_order_poll_cursor.sql — Phase G2 order.paid event poll cursor
--
-- Separate from `events_cursor` (OpenObserve shipping): the store-order ingest
-- tick polls the same CMS feed but only acts on `order.paid` for connected sites.
-- ============================================================================

ALTER TABLE platform_cms_config
    ADD COLUMN IF NOT EXISTS store_order_ingest_cursor timestamptz;
