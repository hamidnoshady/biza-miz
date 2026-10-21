-- Product price history & safety — issue #924 F07, F01, F11
-- Immutable per-cell history for every price change path, plus
-- safety guard for purchase-cost bulk operations.
--
-- Numbered 0235: 0232 is `product_attribute_master_sync`, 0233 is
-- `menu_item_create_idempotency`, and 0234 is `media_library_hardening` — all
-- on main — so this file takes the next free number and never shares one with
-- an unrelated migration. (It shipped as 0234 before main added its own.)

-- Price history: append-only, per branch, per item, per price type
CREATE TABLE IF NOT EXISTS product_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  price_kind text NOT NULL CHECK (price_kind IN ('sale','purchase','list')),
  price_list_id uuid REFERENCES price_lists(id) ON DELETE SET NULL,
  old_price bigint,
  new_price bigint,
  old_price_rial bigint,
  new_price_rial bigint,
  batch_id uuid,
  idempotency_key text,
  -- `recommendation` is a price the retail advisor suggested and the user
  -- accepted unchanged; the metadata column records the inputs it was derived
  -- from so the audit can be reproduced (issue #924, code review item 3).
  source text NOT NULL CHECK (source IN ('manual','bulk','import','ai','sync','system','recommendation')),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text,
  note text,
  -- Reproducible inputs for derived prices (recommendation mode, overheads,
  -- rounding policy, tax preview). Null for plain manual edits.
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A database created before `metadata` existed gets the column here; the
-- insert paths always name it, so a missing column would fail every write.
ALTER TABLE product_price_history ADD COLUMN IF NOT EXISTS metadata jsonb;

-- The source vocabulary grew; an environment that already created the table
-- with the old CHECK must be widened, not left rejecting `recommendation`.
ALTER TABLE product_price_history DROP CONSTRAINT IF EXISTS product_price_history_source_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_product_price_history_source'
  ) THEN
    ALTER TABLE product_price_history ADD CONSTRAINT chk_product_price_history_source
      CHECK (source IN ('manual','bulk','import','ai','sync','system','recommendation'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_product_price_history_item ON product_price_history(item_id);
CREATE INDEX IF NOT EXISTS idx_product_price_history_location ON product_price_history(location_id);
CREATE INDEX IF NOT EXISTS idx_product_price_history_business ON product_price_history(business_id);
CREATE INDEX IF NOT EXISTS idx_product_price_history_created ON product_price_history(created_at);
CREATE INDEX IF NOT EXISTS idx_product_price_history_batch ON product_price_history(batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_price_history_idempotency
  ON product_price_history(idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE product_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_price_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON product_price_history;
CREATE POLICY tenant_isolation ON product_price_history FOR ALL
  USING (app_rls_bypass() OR app_owns_location(location_id))
  WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

-- Ensure item_stock has quantity default and updated_at already exists (0068)
-- Add comment for purchase-cost safety documentation
COMMENT ON COLUMN item_stock.unit_cost IS 'Weighted-average carrying cost — never bulk-overwritten when quantity>0 (issue #924 F01)';
COMMENT ON COLUMN item_stock.unit_price IS 'Shelf sale price — guard >0, immutable history in product_price_history';

-- Currency constraint tightening: price_lists.currency must be a supported code.
--
-- Legacy coercion (documented so an operator reading this migration knows what
-- it changed): older `createPriceList` accepted arbitrary text, so rows may hold
-- `NULL`, lowercase/whitespace variants (`irr`, `IRT `) or free text (`تومان`).
-- Postgres cannot add the CHECK while those rows exist, and the app displays the
-- stored code, so this migration rewrites every unsupported/NULL value to the
-- canonical Rial code `IRR` *before* the constraint is created. The coercion is
-- deliberate and one-way: `IRT`/`USD`/`EUR` are preserved exactly, while
-- lowercase or padded spellings of a supported code are normalised (trimmed and
-- upper-cased) rather than collapsed to IRR. `createPriceList` now rejects an
-- unsupported code on write, so this backfill cannot grow.
UPDATE price_lists
   SET currency = upper(btrim(currency))
 WHERE currency IS NOT NULL
   AND upper(btrim(currency)) IN ('IRR', 'IRT', 'USD', 'EUR')
   AND currency <> upper(btrim(currency));

UPDATE price_lists
   SET currency = 'IRR'
 WHERE currency IS NULL OR currency NOT IN ('IRR', 'IRT', 'USD', 'EUR');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_price_lists_currency_supported'
  ) THEN
    ALTER TABLE price_lists ADD CONSTRAINT chk_price_lists_currency_supported
      CHECK (currency IN ('IRR','IRT','USD','EUR'));
  END IF;
END $$;

-- Product pricing source vocabulary for history
COMMENT ON TABLE product_price_history IS 'Immutable audit for all product price changes — manual, bulk, import, AI, sync, recommendation (issue #924 F07)';
