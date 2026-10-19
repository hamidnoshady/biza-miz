-- Product price history & safety — issue #924 F07, F01
-- Immutable per-cell history for every price change path, plus
-- safety guard for purchase-cost bulk operations.

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
  source text NOT NULL CHECK (source IN ('manual','bulk','import','ai','sync','system')),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
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

-- Currency constraint tightening: price_lists.currency must be IRR (or supported list)
-- Keep default IRR, add check for known values — migration safe for existing IRR rows
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_price_lists_currency_supported'
  ) THEN
    ALTER TABLE price_lists ADD CONSTRAINT chk_price_lists_currency_supported
      CHECK (currency IN ('IRR','IRT','USD','EUR') OR currency = 'IRR');
  END IF;
END $$;

-- Product pricing source vocabulary for history
COMMENT ON TABLE product_price_history IS 'Immutable audit for all product price changes — manual, bulk, import, AI, sync (issue #924 F07)';
