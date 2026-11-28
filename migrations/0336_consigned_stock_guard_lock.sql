-- GH #1567 C5 — make the owned/consigned exclusivity guard race-free.
--
-- 0332's trigger read the variant's open consignment line without a lock. A
-- consigned variant usually has no item_stock row, so the first owned receipt
-- INSERTs one; `receiveConsignedGoods` locks the line FOR UPDATE and then reads
-- item_stock FOR SHARE, which locks nothing when the row does not exist yet.
-- Two concurrent transactions (a consigned receipt and an owned purchase of the
-- same variant) could therefore each see the other's side as empty and both
-- commit, mixing someone else's goods into the shop's carrying value.
--
-- The guard now takes FOR SHARE on the open line. Whichever side locks the
-- line first wins; the other waits for it to commit and then re-reads:
--   * consigned receipt first → the purchase's trigger sees on-hand > 0 and
--     refuses (P0001 consigned_variant_owned_stock);
--   * purchase first → the receipt's FOR UPDATE waits, then its item_stock
--     read (a new statement snapshot) sees owned units and refuses
--     (item_has_owned_stock).
-- The message is unchanged (the services and API map it by code).
CREATE OR REPLACE FUNCTION reject_owned_stock_on_consigned_variant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  consigned numeric;
BEGIN
  IF NEW.quantity > COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.quantity END, 0) THEN
    SELECT l.received_qty - l.sold_qty + l.customer_returned_qty + l.voided_qty - l.returned_to_owner_qty
      INTO consigned
      FROM fashion_consignment_lines l
     WHERE l.item_id = NEW.item_id AND l.is_open
       FOR SHARE;
    IF COALESCE(consigned, 0) > 0 THEN
      RAISE EXCEPTION 'consigned_variant_owned_stock' USING ERRCODE = 'P0001',
        HINT = 'This variant holds consigned units; return them to the owner before receiving owned stock.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
