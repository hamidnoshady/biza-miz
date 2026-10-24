-- 0239_retail_stock_reports_hardening.sql
-- Issue #917 — Accounting → انبار → گزارش audit
--
-- 1. Adds provenance timestamps to item_stock for defensible dead-stock aging.
--    Never-sold stock must not be immediately classified 90-day dead; the
--    report needs a first-acquisition baseline. Existing rows lack that, so
--    we add two columns and backfill from available history:
--      created_at        — when the row first appeared (defaults to now(), backfilled from items.created_at)
--      first_stocked_at  — when positive quantity first appeared (nullable, backfilled where possible)
--    Future inserts populate both; updates to quantity preserve first_stocked_at once set.
--
-- 2. No breaking change to existing queries: COALESCE(created_at, first_stocked_at, items.created_at)
--    is the dead-stock age expression, with updated_at as last fallback.

-- Add nullable first, backfill, then enforce default.
ALTER TABLE item_stock ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE item_stock ADD COLUMN IF NOT EXISTS first_stocked_at timestamptz;

-- Backfill created_at: prefer the item's creation time (product creation is
-- the earliest defensible acquisition baseline for historical imports without
-- explicit receipt dates). Fall back to updated_at for orphan rows.
UPDATE item_stock s
   SET created_at = COALESCE(i.created_at, s.updated_at, now())
  FROM items i
 WHERE i.id = s.item_id
   AND s.created_at IS NULL;

-- Any rows still null (items row missing, e.g. deleted) get now()+updated_at fallback
UPDATE item_stock SET created_at = COALESCE(updated_at, now()) WHERE created_at IS NULL;

-- Default for future inserts
ALTER TABLE item_stock ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE item_stock ALTER COLUMN created_at SET NOT NULL;

-- If the stock row currently holds positive quantity and has no first_stocked_at,
-- assume it was first stocked at created_at; for historical imports without dates
-- this is the best available baseline (issue #917 P1).
UPDATE item_stock s
   SET first_stocked_at = s.created_at
 WHERE s.quantity > 0 AND s.first_stocked_at IS NULL;

-- Trigger: stamp first_stocked_at once when quantity transitions from 0 to >0.
-- INSERT must not touch OLD (undefined in INSERT), so branch on TG_OP first.
CREATE OR REPLACE FUNCTION set_first_stocked_at() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.quantity > 0 AND NEW.first_stocked_at IS NULL THEN
      NEW.first_stocked_at := now();
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.quantity > 0 AND OLD.quantity = 0 AND OLD.first_stocked_at IS NULL AND NEW.first_stocked_at IS NULL THEN
      NEW.first_stocked_at := now();
    END IF;
    -- Once set, never overwrite: preserve original first_stocked_at even if quantity cycles 0→>0 again
    -- So if OLD.first_stocked_at IS NOT NULL, keep it (do not replace)
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_item_stock_first_stocked_at ON item_stock;
CREATE TRIGGER trg_item_stock_first_stocked_at
  BEFORE INSERT OR UPDATE OF quantity ON item_stock
  FOR EACH ROW EXECUTE FUNCTION set_first_stocked_at();

-- Index to support report filters on last_sold_at / created_at ranges
CREATE INDEX IF NOT EXISTS idx_item_stock_last_sold_at ON item_stock (last_sold_at);
CREATE INDEX IF NOT EXISTS idx_item_stock_created_at ON item_stock (created_at);

COMMENT ON COLUMN item_stock.created_at IS 'When the stock row was first created; used as dead-stock age baseline when last_sold_at IS NULL';
COMMENT ON COLUMN item_stock.first_stocked_at IS 'When positive quantity first appeared; set once, never overwritten by stock decrements';
