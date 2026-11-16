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

-- All till entry points write tenders before marking the order completed.
-- Triggering here covers both the live till and split/offline settlement,
-- and rolling back accounting also rolls back delivery.
CREATE FUNCTION cms_order_state_from_pos_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    captured_amount bigint;
    reference text;
    outbox_state text;
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
        outbox_state := 'cancelled';
    ELSIF NEW.status = 'completed' AND NEW.cms_counter_currency IS NOT NULL THEN
        SELECT min(p.id::text) FILTER (WHERE p.method NOT IN ('credit', 'online')),
               COALESCE(sum(p.amount) FILTER (WHERE p.method NOT IN ('credit', 'online')), 0)
          INTO reference, captured_amount
          FROM payments p WHERE p.order_id = NEW.id AND p.location_id = NEW.location_id;
        IF reference IS NULL OR captured_amount < NEW.total OR EXISTS (
            SELECT 1 FROM payments WHERE order_id = NEW.id AND method = 'online'
        ) THEN
            RETURN NEW;
        END IF;
        IF NEW.cms_counter_currency = 'IRT' AND NEW.total % 10 <> 0 THEN
            RETURN NEW;
        END IF;
        captured_amount := CASE WHEN NEW.cms_counter_currency = 'IRT' THEN NEW.total / 10 ELSE NEW.total END;
        outbox_state := 'counter_payment';
    ELSE
        RETURN NEW;
    END IF;
    INSERT INTO cms_order_state_outbox
        (business_id, cms_connection_id, cms_order_id, pos_order_id, state, payment_amount, payment_reference)
    SELECT l.business_id, NEW.cms_connection_id, NEW.cms_order_id, NEW.id, outbox_state, captured_amount, reference
      FROM locations l WHERE l.id = NEW.location_id
    ON CONFLICT (cms_connection_id, cms_order_id, state) DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE TRIGGER cms_order_state_from_pos_status
    AFTER UPDATE OF status ON orders
    FOR EACH ROW EXECUTE FUNCTION cms_order_state_from_pos_status();
