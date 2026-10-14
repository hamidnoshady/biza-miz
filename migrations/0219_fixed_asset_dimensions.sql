-- ===========================================================================
-- 0219_fixed_asset_dimensions.sql — default accounting-dimension attribution
-- for fixed assets (issue #868).
--
-- An asset carries an optional default dimension set (cost centre, profit
-- centre, department, detail). The asset's acquisition entry, every
-- depreciation posting and its disposal entry all carry those dimensions on
-- the depreciation-expense / fixed-asset / gain-loss leg; the settlement leg
-- (cash/bank/payable/proceeds) remains unattributed because settlement accounts
-- are not where a cost lives. Reversals continue to mirror through
-- postExactMirrorEntry(dimensionMirror: true).
--
-- RLS: the new columns sit on fixed_assets, which already has forced RLS with
-- a tenant_isolation policy from 0058, so no new policy is required. The
-- journal_lines the asset writes continue to go through trg_journal_lines_dimension_guard.
-- ===========================================================================

ALTER TABLE fixed_assets
  ADD COLUMN cost_center_id uuid REFERENCES accounting_dimension_values(id) ON DELETE SET NULL,
  ADD COLUMN profit_center_id uuid REFERENCES accounting_dimension_values(id) ON DELETE SET NULL,
  ADD COLUMN department_id uuid REFERENCES accounting_dimension_values(id) ON DELETE SET NULL,
  ADD COLUMN detail_dimension_id uuid REFERENCES accounting_dimension_values(id) ON DELETE SET NULL;

-- Indexed lookups are by asset when reporting; a covering index on (business, kind)
-- is not needed because the list is bounded per asset.
CREATE INDEX idx_fixed_assets_cost_center ON fixed_assets (business_id, cost_center_id) WHERE cost_center_id IS NOT NULL;
CREATE INDEX idx_fixed_assets_profit_center ON fixed_assets (business_id, profit_center_id) WHERE profit_center_id IS NOT NULL;
CREATE INDEX idx_fixed_assets_department ON fixed_assets (business_id, department_id) WHERE department_id IS NOT NULL;
CREATE INDEX idx_fixed_assets_detail ON fixed_assets (business_id, detail_dimension_id) WHERE detail_dimension_id IS NOT NULL;

-- Structural guard: every dimension value attached here must belong to the same
-- business and the column it sits in, the same way journal_lines is guarded.
-- The posting policy (assertDimensionsPostable) decides whether the value is
-- active/leaf/branch-matched/in-window at write time; this trigger refuses
-- anything no decision could make true.
CREATE OR REPLACE FUNCTION trg_fixed_asset_dimensions_check() RETURNS trigger AS $$
BEGIN
    PERFORM accounting_dimension_check_all(
        NEW.business_id,
        NEW.cost_center_id, NEW.profit_center_id, NEW.department_id, NEW.detail_dimension_id
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fixed_asset_dimensions_check ON fixed_assets;
CREATE TRIGGER trg_fixed_asset_dimensions_check
    BEFORE INSERT OR UPDATE OF cost_center_id, profit_center_id, department_id, detail_dimension_id
    ON fixed_assets
    FOR EACH ROW EXECUTE FUNCTION trg_fixed_asset_dimensions_check();
