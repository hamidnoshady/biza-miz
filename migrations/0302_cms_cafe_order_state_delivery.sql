-- This migration backfills every tenant, including under FORCE RLS.
SET LOCAL app.rls_bypass = 'on';

ALTER TABLE cms_order_state_outbox
    DROP CONSTRAINT cms_order_state_outbox_state_check,
    ADD CONSTRAINT cms_order_state_outbox_state_check
        CHECK (state IN ('accepted', 'rejected', 'preparing', 'ready', 'served', 'cancelled', 'counter_payment')),
    ADD COLUMN version bigint GENERATED ALWAYS AS IDENTITY,
    ADD COLUMN site_id text,
    ADD COLUMN payment_amount bigint,
    ADD COLUMN payment_reference text,
    ADD COLUMN lease_token uuid,
    ADD COLUMN lease_until timestamptz,
    ADD COLUMN dead_lettered_at timestamptz;

UPDATE cms_order_state_outbox AS delivery
   SET site_id = connection.site_id
  FROM eshobe_cms_connections AS connection
 WHERE connection.id = delivery.cms_connection_id
   AND connection.business_id = delivery.business_id;

ALTER TABLE cms_order_state_outbox ALTER COLUMN site_id SET NOT NULL;

DROP INDEX idx_cms_order_state_outbox_due;
CREATE INDEX idx_cms_order_state_outbox_due
    ON cms_order_state_outbox (next_attempt_at, version)
    WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX idx_cms_order_state_outbox_predecessor
    ON cms_order_state_outbox (cms_connection_id, cms_order_id, version)
    WHERE delivered_at IS NULL AND state <> 'counter_payment';

-- Capture the site at enqueue time, including for the existing approval writer.
CREATE FUNCTION cms_order_state_capture_site() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    SELECT site_id INTO NEW.site_id
      FROM eshobe_cms_connections
     WHERE id = NEW.cms_connection_id AND business_id = NEW.business_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER cms_order_state_capture_site
    BEFORE INSERT ON cms_order_state_outbox
    FOR EACH ROW EXECUTE FUNCTION cms_order_state_capture_site();

-- Only explicitly counter-payable CMS orders qualify. The currency preserves
-- the selected checkout's unit when expressing the verified POS amount.
ALTER TABLE orders ADD COLUMN cms_counter_currency text
    CHECK (cms_counter_currency IN ('IRR', 'IRT'));

UPDATE orders AS o
   SET cms_counter_currency = i.payload #>> '{order,currency}'
  FROM cms_store_order_inbox AS i, locations AS l
 WHERE i.cms_connection_id = o.cms_connection_id AND i.cms_order_id = o.cms_order_id
   AND l.id = o.location_id AND i.business_id = l.business_id AND i.event_topic = 'order.submitted'
   AND i.status = 'processed' AND i.payload #>> '{order,paymentMethod}' = 'counter'
   AND i.payload #>> '{order,currency}' IN ('IRR', 'IRT');

CREATE FUNCTION cms_record_cafe_kitchen_state(target_order_id uuid) RETURNS void LANGUAGE sql AS $$
    WITH progress AS (
        SELECT o.id, l.business_id, o.cms_connection_id, o.cms_order_id,
               bool_or(oi.status IN ('preparing', 'ready', 'served')) AS preparing,
               bool_and(oi.status IN ('ready', 'served')) AS ready,
               bool_and(oi.status = 'served') AS served
          FROM orders o
          JOIN locations l ON l.id = o.location_id
          JOIN order_items oi ON oi.order_id = o.id AND oi.status <> 'voided'
         WHERE ($1 IS NULL OR o.id = $1) AND o.origin = 'website' AND o.website_approval_state = 'accepted'
           AND o.cms_connection_id IS NOT NULL AND o.cms_order_id IS NOT NULL
         GROUP BY o.id, l.business_id
     )
     INSERT INTO cms_order_state_outbox (business_id, cms_connection_id, cms_order_id, pos_order_id, state)
     SELECT business_id, cms_connection_id, cms_order_id, id, milestone.state
       FROM progress
       CROSS JOIN LATERAL (VALUES (1, 'preparing', preparing), (2, 'ready', ready), (3, 'served', served))
         AS milestone(position, state, reached)
      WHERE milestone.reached
      ORDER BY milestone.position
     ON CONFLICT (cms_connection_id, cms_order_id, state) DO NOTHING;
$$;

CREATE FUNCTION cms_record_cafe_counter_payment(target_order orders) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    captured_amount bigint;
    reference text;
BEGIN
    SELECT min(p.id::text) FILTER (WHERE p.method NOT IN ('credit', 'online')),
           COALESCE(sum(p.amount) FILTER (WHERE p.method NOT IN ('credit', 'online')), 0)
      INTO reference, captured_amount
      FROM payments p WHERE p.order_id = target_order.id AND p.location_id = target_order.location_id;
    IF reference IS NULL OR captured_amount < target_order.total OR EXISTS (
        SELECT 1 FROM payments WHERE order_id = target_order.id AND method = 'online'
    ) THEN
        RETURN;
    END IF;
    captured_amount := CASE
        WHEN target_order.cms_counter_currency = 'IRR' THEN target_order.total
        WHEN target_order.total % 10 = 0 THEN target_order.total / 10
    END;
    INSERT INTO cms_order_state_outbox
        (business_id, cms_connection_id, cms_order_id, pos_order_id, state, payment_amount, payment_reference)
    SELECT l.business_id, target_order.cms_connection_id, target_order.cms_order_id,
           target_order.id, 'counter_payment', captured_amount, reference
      FROM locations l WHERE l.id = target_order.location_id
    ON CONFLICT (cms_connection_id, cms_order_id, state) DO NOTHING;
END;
$$;

-- All till entry points write tenders before marking the order completed.
-- Triggering here covers both the live till and split/offline settlement,
-- and rolling back accounting also rolls back delivery.
CREATE FUNCTION cms_order_state_from_pos_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.origin <> 'website' OR NEW.cms_connection_id IS NULL OR NEW.cms_order_id IS NULL
       OR NEW.website_approval_state IS NULL OR OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;
    IF NEW.status = 'voided' AND NEW.website_approval_state <> 'rejected' AND NOT EXISTS (
        SELECT 1 FROM cms_order_state_outbox
         WHERE cms_connection_id = NEW.cms_connection_id AND cms_order_id = NEW.cms_order_id
           AND state = 'served'
    ) THEN
        INSERT INTO cms_order_state_outbox (business_id, cms_connection_id, cms_order_id, pos_order_id, state)
        SELECT l.business_id, NEW.cms_connection_id, NEW.cms_order_id, NEW.id, 'cancelled'
          FROM locations l WHERE l.id = NEW.location_id
        ON CONFLICT (cms_connection_id, cms_order_id, state) DO NOTHING;
    ELSIF NEW.status = 'completed' AND NEW.cms_counter_currency IS NOT NULL THEN
        PERFORM cms_record_cafe_counter_payment(NEW);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER cms_order_state_from_pos_status
    AFTER UPDATE OF status ON orders
    FOR EACH ROW EXECUTE FUNCTION cms_order_state_from_pos_status();

-- Reconcile orders that already progressed before the delivery worker existed.
SELECT cms_record_cafe_kitchen_state(NULL);

INSERT INTO cms_order_state_outbox (business_id, cms_connection_id, cms_order_id, pos_order_id, state)
SELECT l.business_id, o.cms_connection_id, o.cms_order_id, o.id, 'cancelled'
  FROM orders o JOIN locations l ON l.id = o.location_id
 WHERE o.origin = 'website' AND o.cms_connection_id IS NOT NULL AND o.cms_order_id IS NOT NULL
   AND o.status = 'voided' AND o.website_approval_state <> 'rejected'
   AND NOT EXISTS (
       SELECT 1 FROM cms_order_state_outbox prior
        WHERE prior.cms_connection_id = o.cms_connection_id AND prior.cms_order_id = o.cms_order_id
          AND prior.state = 'served'
   )
ON CONFLICT (cms_connection_id, cms_order_id, state) DO NOTHING;

SELECT cms_record_cafe_counter_payment(o)
  FROM orders o
 WHERE o.origin = 'website' AND o.cms_connection_id IS NOT NULL AND o.cms_order_id IS NOT NULL
   AND o.website_approval_state IS NOT NULL AND o.status = 'completed' AND o.cms_counter_currency IS NOT NULL;
