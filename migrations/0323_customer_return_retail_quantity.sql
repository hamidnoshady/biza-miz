-- Issue #1567 (Phase 3) — customer returns on items-model (retail) invoice lines.
--
-- `enforce_customer_return_quantity()` (migration 0017) caps the cumulative
-- returned quantity of an order line at `order_items.quantity`. That is the
-- true sold quantity for warehouse/F&B lines, but retail-invoice lines always
-- store `1` there and keep the real quantity in `retail_snapshot.quantity`
-- (see retail-invoice-void-service.ts). The trigger therefore refused any
-- return of more than one unit of a multi-unit retail line — a shop that sold
-- three shirts on one line could only take one back.
--
-- The cap now reads the same *effective* quantity customer-return-service.ts
-- uses: the snapshot's quantity when the line carries a well-formed one, the
-- raw column otherwise. Lines without a snapshot (every F&B / warehouse line)
-- behave exactly as before. Idempotent: CREATE OR REPLACE on the function the
-- existing trigger already calls.

CREATE OR REPLACE FUNCTION enforce_customer_return_quantity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sold numeric(24,9); returned numeric(24,9);
BEGIN
  SELECT CASE
           WHEN jsonb_typeof(retail_snapshot -> 'quantity') = 'string'
                AND (retail_snapshot ->> 'quantity') ~ '^[0-9]+(\.[0-9]+)?$'
             THEN (retail_snapshot ->> 'quantity')::numeric(24,9)
           ELSE quantity
         END
    INTO sold
    FROM order_items WHERE id=NEW.order_item_id FOR UPDATE;
  IF sold IS NULL THEN RAISE EXCEPTION 'order_item_not_found'; END IF;
  SELECT COALESCE(sum(l.quantity),0) INTO returned
    FROM customer_return_lines l WHERE l.order_item_id=NEW.order_item_id AND l.id<>NEW.id;
  IF returned + NEW.quantity > sold THEN RAISE EXCEPTION 'return_quantity_exceeds_sold'; END IF;
  RETURN NEW;
END $$;
