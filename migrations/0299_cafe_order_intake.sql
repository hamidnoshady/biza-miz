-- ============================================================================
-- 0299_cafe_order_intake.sql — ESH-146 (biza-miz#1304)
--
-- Café orders arrive from an Eshobe CMS checkout *before* they are paid:
-- `order.submitted` is emitted for every committed order, `order.paid` later
-- for verified online payment. The Phase G inbox (0180) assumed one row per CMS
-- order, created by `order.paid`, and imported a completed retail/delivery
-- sale. A café order is two events and two separate states — approval and
-- payment — so the inbox has to hold both topics per order, and the POS order
-- has to remember where it came from and whether staff have approved it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Two events, one order.
--
-- 0180's `UNIQUE (cms_connection_id, cms_order_id)` made the second event for
-- an order impossible to record: `order.submitted` and `order.paid` are not
-- duplicates of each other, they are two independent facts about one CMS
-- order, and the acceptance criterion is that a replay of either converges on
-- the same POS order. Key the inbox by (connection, order, topic) instead;
-- `imported_order_id` on both rows names the one POS order they produced.
-- ----------------------------------------------------------------------------
ALTER TABLE cms_store_order_inbox
    DROP CONSTRAINT IF EXISTS cms_store_order_inbox_cms_connection_id_cms_order_id_key;

ALTER TABLE cms_store_order_inbox
    ADD CONSTRAINT cms_store_order_inbox_order_topic_key
        UNIQUE (cms_connection_id, cms_order_id, event_topic);

-- ----------------------------------------------------------------------------
-- 2. Where a POS order came from, and whether staff have accepted it.
--
-- `origin` is the durable source marker the orders screen shows; the
-- approval columns are the separate state machine the ticket requires
-- (`pending` → `accepted` | `rejected`), deliberately *not* overloading
-- `orders.status`, which belongs to the till (open/held/completed/void).
--
-- A rejected order keeps its money. If it was paid online, the refund is the
-- existing refund process; this state records the decision, the actor and the
-- reason so that flow has an owner and an audit trail.
-- ----------------------------------------------------------------------------
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'pos'
        CHECK (origin IN ('pos', 'website', 'woocommerce', 'holoo', 'import'));

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS cms_connection_id uuid
        REFERENCES eshobe_cms_connections(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS cms_order_id text,
    ADD COLUMN IF NOT EXISTS website_approval_state text
        CHECK (website_approval_state IN ('pending', 'accepted', 'rejected')),
    ADD COLUMN IF NOT EXISTS website_approval_decided_at timestamptz,
    ADD COLUMN IF NOT EXISTS website_approval_decided_by uuid
        REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS website_approval_reason text;

-- One POS order per CMS order. The intake's `clientRequestId` already makes a
-- replay return the same order; this index is the database-level answer to two
-- concurrent deliveries racing that check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_cms_order
    ON orders (cms_connection_id, cms_order_id)
    WHERE cms_order_id IS NOT NULL;

-- The approval queue reads exactly this slice.
CREATE INDEX IF NOT EXISTS idx_orders_website_approval
    ON orders (location_id, website_approval_state)
    WHERE website_approval_state IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. Durable POS → CMS state outbox.
--
-- Accepting or rejecting a website order is a state change the customer's
-- order page must eventually show, and the CMS can be down when a cashier
-- presses the button. The row is written in the same transaction as the
-- decision, keyed so a double press cannot enqueue twice; delivery (retry,
-- backoff, dead letters) is ESH-148's worker, reading this table.
-- ----------------------------------------------------------------------------
CREATE TABLE cms_order_state_outbox (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    cms_connection_id uuid NOT NULL REFERENCES eshobe_cms_connections(id) ON DELETE CASCADE,
    cms_order_id      text NOT NULL,
    pos_order_id      uuid REFERENCES orders(id) ON DELETE SET NULL,
    state             text NOT NULL CHECK (state IN ('accepted', 'rejected')),
    reason            text,
    attempts          integer NOT NULL DEFAULT 0,
    next_attempt_at   timestamptz NOT NULL DEFAULT now(),
    delivered_at      timestamptz,
    last_error        text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cms_connection_id, cms_order_id, state)
);

CREATE INDEX idx_cms_order_state_outbox_due
    ON cms_order_state_outbox (next_attempt_at)
    WHERE delivered_at IS NULL;

ALTER TABLE cms_order_state_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cms_order_state_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cms_order_state_outbox FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
