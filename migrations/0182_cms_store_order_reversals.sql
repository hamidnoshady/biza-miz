-- ============================================================================
-- 0182_cms_store_order_reversals.sql — CMS refund/cancel inbox events (Phase G2)
--
-- Reversal deliveries share a CMS order id with the original `order.paid` row.
-- Drop the one-row-per-order constraint; keep one paid import per connection+order.
-- ============================================================================

ALTER TABLE cms_store_order_inbox
    DROP CONSTRAINT IF EXISTS cms_store_order_inbox_cms_connection_id_cms_order_id_key;

ALTER TABLE cms_store_order_inbox
    ADD COLUMN reversal_amendment_id uuid REFERENCES order_amendments(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX cms_store_order_inbox_one_paid_topic
    ON cms_store_order_inbox (cms_connection_id, cms_order_id)
    WHERE event_topic = 'order.paid';

CREATE INDEX idx_cms_store_order_inbox_paid_import
    ON cms_store_order_inbox (cms_connection_id, cms_order_id)
    WHERE event_topic = 'order.paid' AND status = 'processed';
