-- 0308_cms_cafe_counter_refund.sql — ESH-148 follow-up
--
-- The CMS supports a *full* refund of a counter payment: staff hand the money
-- back at the till and the customer's order page must show «بازپرداخت‌شده».
-- 0302 taught the state outbox the counter-payment half of that relationship
-- but not the refund, so a refunded café order stayed `paid` on the site.
--
-- The money lives at the till, so the refund is recorded there first
-- (`customer_returns`, in the same transaction as its stock and ledger
-- postings) and only then queued for the CMS. The trigger is the one writer:
-- every refund path — the counter screen, the AI executor and a replayed sync
-- event — inserts a `customer_returns` row, and none of them can forget the
-- outbox.
--
-- Only a full refund is queued: the CMS's counter-refund contract is whole
-- order, not partial. A partial refund leaves the site's order alone until the
-- cumulative refund reaches the order total.
SET LOCAL app.rls_bypass = 'on';

ALTER TABLE cms_order_state_outbox
    DROP CONSTRAINT cms_order_state_outbox_state_check,
    ADD CONSTRAINT cms_order_state_outbox_state_check
        CHECK (state IN ('accepted', 'rejected', 'preparing', 'ready', 'served',
                         'cancelled', 'counter_payment', 'counter_refund'));

-- A refund's predecessor check now has to see an undelivered counter payment,
-- which 0302's partial index deliberately excluded.
DROP INDEX idx_cms_order_state_outbox_predecessor;
CREATE INDEX idx_cms_order_state_outbox_predecessor
    ON cms_order_state_outbox (cms_connection_id, cms_order_id, version)
    WHERE delivered_at IS NULL;

-- Queue one refund after the cumulative customer returns on an order cover its
-- total. The refund mirrors the counter-payment row the site already has — its
-- amount, its unit and its accounting reference — so the site reverses exactly
-- the payment it was told about, and an order with no delivered payment row
-- never receives a refund for money it has not seen.
CREATE FUNCTION cms_record_cafe_counter_refund(target_order_id uuid, refund_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    target_order orders%ROWTYPE;
    refunded bigint;
    captured_amount bigint;
    reference text;
BEGIN
    SELECT * INTO target_order FROM orders WHERE id = target_order_id;
    IF NOT FOUND
       OR target_order.origin <> 'website'
       OR target_order.cms_connection_id IS NULL
       OR target_order.cms_order_id IS NULL
       OR target_order.cms_counter_currency IS NULL
       OR target_order.total <= 0 THEN
        RETURN;
    END IF;

    SELECT COALESCE(sum(refund_amount_rial), 0)
      INTO refunded
      FROM customer_returns
     WHERE order_id = target_order.id;
    -- A partial refund is not a CMS counter refund.
    IF refunded < target_order.total THEN
        RETURN;
    END IF;

    SELECT payment_amount, payment_reference
      INTO captured_amount, reference
      FROM cms_order_state_outbox
     WHERE pos_order_id = target_order.id
       AND cms_connection_id = target_order.cms_connection_id
       AND cms_order_id = target_order.cms_order_id
       AND state = 'counter_payment'
     LIMIT 1;
    IF captured_amount IS NULL OR captured_amount <= 0 THEN
        RETURN;
    END IF;

    INSERT INTO cms_order_state_outbox
        (business_id, cms_connection_id, cms_order_id, pos_order_id, state,
         payment_amount, payment_reference)
    SELECT l.business_id, target_order.cms_connection_id, target_order.cms_order_id,
           target_order.id, 'counter_refund', captured_amount,
           COALESCE(reference, refund_id::text)
      FROM locations l
     WHERE l.id = target_order.location_id
    ON CONFLICT (cms_connection_id, cms_order_id, state) DO NOTHING;
END;
$$;

CREATE FUNCTION cms_order_state_from_customer_return() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM cms_record_cafe_counter_refund(NEW.order_id, NEW.id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER cms_order_state_from_customer_return
    AFTER INSERT ON customer_returns
    FOR EACH ROW EXECUTE FUNCTION cms_order_state_from_customer_return();

-- Reconcile orders that were fully refunded before this migration existed.
SELECT cms_record_cafe_counter_refund(
    o.id,
    (SELECT r.id FROM customer_returns r
      WHERE r.order_id = o.id
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 1)
)
  FROM orders o
 WHERE o.origin = 'website'
   AND o.cms_connection_id IS NOT NULL
   AND o.cms_order_id IS NOT NULL
   AND o.cms_counter_currency IS NOT NULL
   AND o.total > 0
   AND EXISTS (SELECT 1 FROM customer_returns r WHERE r.order_id = o.id);
