-- ============================================================================
-- 0180_cms_store_order_inbox.sql — CMS store paid orders inbox (Phase G)
--
-- Mirrors WooCommerce's integration_webhook_events shape for eshobe-cms store
-- checkouts: idempotent deliveries, one accounting import per CMS order id.
-- ============================================================================

CREATE TABLE cms_store_order_inbox (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    cms_connection_id  uuid NOT NULL REFERENCES eshobe_cms_connections(id) ON DELETE CASCADE,
    event_topic        text NOT NULL CHECK (char_length(event_topic) BETWEEN 1 AND 120),
    cms_order_id       text NOT NULL,
    delivery_id        text NOT NULL,
    payload            jsonb NOT NULL,
    status             text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'processed', 'failed', 'duplicate')),
    error              text,
    imported_order_id  uuid REFERENCES orders(id) ON DELETE SET NULL,
    processed_at       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cms_connection_id, delivery_id),
    UNIQUE (cms_connection_id, cms_order_id)
);

CREATE INDEX idx_cms_store_order_inbox_business
    ON cms_store_order_inbox (business_id, created_at DESC);
CREATE INDEX idx_cms_store_order_inbox_status
    ON cms_store_order_inbox (business_id, status, created_at DESC);

ALTER TABLE cms_store_order_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cms_store_order_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cms_store_order_inbox FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
