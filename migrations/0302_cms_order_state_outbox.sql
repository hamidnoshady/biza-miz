-- ============================================================================
-- 0302_cms_order_state_outbox.sql — ESH-148 (biza-miz#1306): Durable CMS
-- order-state outbox.
--
-- POS owns operational order progression after website intake and mirrors
-- fulfillment (`accepted`, `preparing`, `ready`, `served`, `rejected`) and
-- payment/lifecycle (`paid`, `cancelled`, `refunded`) states back to
-- `eshobe-cms` over two independent monotonic axes:
--
--   axis = 'fulfillment' → updates `cafe.fulfillment` & `cafe.fulfillmentAt`
--   axis = 'payment'     → updates `Orders.status`
--
-- Separating the two axes lets kitchen readiness advance independently of
-- online vs. counter payment and lets a paid rejected order be refunded
-- cleanly (`fulfillment = rejected`, then `payment = refunded`) while
-- enforcing strict monotonic ordering within each axis.
-- ============================================================================

CREATE TABLE cms_order_state_outbox (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id       uuid REFERENCES locations(id) ON DELETE SET NULL,
    cms_connection_id uuid NOT NULL REFERENCES eshobe_cms_connections(id) ON DELETE CASCADE,
    site_id           text NOT NULL,
    cms_order_id      text NOT NULL,
    pos_order_id      uuid REFERENCES orders(id) ON DELETE SET NULL,
    axis              text NOT NULL CHECK (axis IN ('fulfillment', 'payment')),
    state             text NOT NULL CHECK (state IN (
                          'accepted',
                          'rejected',
                          'preparing',
                          'ready',
                          'served',
                          'paid',
                          'cancelled',
                          'refunded'
                      )),
    state_version     integer NOT NULL CHECK (state_version > 0),
    reason            text,
    payload           jsonb NOT NULL DEFAULT '{}'::jsonb
                          CHECK (jsonb_typeof(payload) = 'object'),
    status            text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead', 'superseded')),
    attempts          integer NOT NULL DEFAULT 0,
    next_attempt_at   timestamptz NOT NULL DEFAULT now(),
    leased_until      timestamptz,
    lease_token       uuid,
    delivered_at      timestamptz,
    last_error        text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cms_connection_id, cms_order_id, axis, state_version)
);

CREATE INDEX idx_cms_order_state_outbox_due
    ON cms_order_state_outbox (business_id, cms_connection_id, next_attempt_at, state_version)
    WHERE status IN ('pending', 'failed');

CREATE INDEX idx_cms_order_state_outbox_lease
    ON cms_order_state_outbox (leased_until)
    WHERE status = 'processing';

CREATE INDEX idx_cms_order_state_outbox_order
    ON cms_order_state_outbox (pos_order_id, created_at DESC);

CREATE INDEX idx_cms_order_state_outbox_status
    ON cms_order_state_outbox (business_id, status, updated_at DESC);

ALTER TABLE cms_order_state_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cms_order_state_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cms_order_state_outbox FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
