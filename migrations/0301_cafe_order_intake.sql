-- ============================================================================
-- 0301_cafe_order_intake.sql — ESH-146 (biza-miz#1304): Café website order
-- intake & approval gate.
--
-- Extends `cms_store_order_inbox` to key per `(cms_connection_id, cms_order_id,
-- event_topic)` so `order.submitted`, `order.paid`, and reversals for the same
-- CMS order are tracked independently, and stamps website intake / staff
-- approval columns onto `orders`.
-- ============================================================================

ALTER TABLE cms_store_order_inbox
    DROP CONSTRAINT IF EXISTS cms_store_order_inbox_cms_connection_id_cms_order_id_key;

ALTER TABLE cms_store_order_inbox
    ADD CONSTRAINT uq_cms_store_order_inbox_event
        UNIQUE (cms_connection_id, cms_order_id, event_topic);

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'pos'
        CHECK (origin IN ('pos', 'website')),
    ADD COLUMN IF NOT EXISTS cms_connection_id uuid
        REFERENCES eshobe_cms_connections(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS cms_order_id text,
    ADD COLUMN IF NOT EXISTS website_approval_state text
        CHECK (website_approval_state IS NULL OR website_approval_state IN ('pending', 'accepted', 'rejected')),
    ADD COLUMN IF NOT EXISTS website_approval_decided_at timestamptz,
    ADD COLUMN IF NOT EXISTS website_approval_decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS website_approval_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_cms_order
    ON orders (cms_connection_id, cms_order_id)
    WHERE cms_connection_id IS NOT NULL AND cms_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_website_approval
    ON orders (location_id, website_approval_state, opened_at)
    WHERE website_approval_state = 'pending';
