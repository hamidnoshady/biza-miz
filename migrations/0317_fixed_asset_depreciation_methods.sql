-- ---------------------------------------------------------------------------
-- 0316_fixed_asset_depreciation_methods.sql — issue #1325: accountant-selected
-- depreciation methods beyond straight-line, and the facts a projected
-- depreciation schedule needs.
--
-- Additive only. Every existing asset keeps `depreciation_method =
-- 'straight_line'`, a NULL rate, the `none` switch policy and a NULL capacity,
-- so its arithmetic is unchanged: the service resolves missing method data to
-- straight-line, and the new CHECK constraints hold for every legacy row.
--
--   1. The asset carries its CURRENT approved method (the accountant's
--      selection). Method parameters only exist for the method that uses them,
--      so a method change cannot leave a stale rate or capacity behind:
--        * declining_balance  -> declining_balance_rate_bps NOT NULL
--        * units_of_production -> total_capacity_units NOT NULL
--
--   2. Each posted depreciation row snapshots the method that priced it, and
--      (for units-of-production) the units it charged. History therefore says
--      HOW an amount was computed, not just how much — the same discipline the
--      estimate-change snapshots already follow.
--
--   3. `fixed_asset_estimate_changes` grows the old/new method facts, so a
--      prospective method change is audited exactly like a life/salvage
--      revision. Existing rows default to straight-line on both sides, which is
--      what they were.
-- ---------------------------------------------------------------------------

ALTER TABLE fixed_assets
    ADD COLUMN depreciation_method text NOT NULL DEFAULT 'straight_line'
        CHECK (depreciation_method IN ('straight_line', 'declining_balance', 'units_of_production')),
    -- Annual rate in basis points: 2500 = 25% per year.
    ADD COLUMN declining_balance_rate_bps integer
        CHECK (declining_balance_rate_bps IS NULL
               OR (declining_balance_rate_bps > 0 AND declining_balance_rate_bps <= 10000)),
    ADD COLUMN declining_balance_switch_policy text NOT NULL DEFAULT 'none'
        CHECK (declining_balance_switch_policy IN ('none', 'straight_line')),
    -- Approved lifetime production capacity (whole units; the unit itself is a
    -- label such as «عدد», «کیلوگرم», «ساعت کارکرد»).
    ADD COLUMN total_capacity_units bigint
        CHECK (total_capacity_units IS NULL OR total_capacity_units > 0),
    ADD COLUMN capacity_unit_label text,
    ADD CONSTRAINT fixed_assets_declining_balance_parameters CHECK (
        (depreciation_method = 'declining_balance') = (declining_balance_rate_bps IS NOT NULL)
    ),
    ADD CONSTRAINT fixed_assets_units_of_production_parameters CHECK (
        (depreciation_method = 'units_of_production') = (total_capacity_units IS NOT NULL)
    );

-- Every posted depreciation row records what priced it. Legacy rows were
-- straight-line by definition (the only method that existed before this
-- migration), so the default is a statement of fact, not an assumption.
ALTER TABLE fixed_asset_depreciation_entries
    ADD COLUMN method text NOT NULL DEFAULT 'straight_line'
        CHECK (method IN ('straight_line', 'declining_balance', 'units_of_production')),
    ADD COLUMN units_produced bigint
        CHECK (units_produced IS NULL OR units_produced >= 0),
    ADD CONSTRAINT fixed_asset_depreciation_units_shape CHECK (
        method = 'units_of_production' OR units_produced IS NULL
    );

-- Effective-dated method history lives beside the life/salvage revisions it is
-- recorded with: one prospective change, one audited row, one reason.
ALTER TABLE fixed_asset_estimate_changes
    ADD COLUMN old_method text NOT NULL DEFAULT 'straight_line'
        CHECK (old_method IN ('straight_line', 'declining_balance', 'units_of_production')),
    ADD COLUMN new_method text NOT NULL DEFAULT 'straight_line'
        CHECK (new_method IN ('straight_line', 'declining_balance', 'units_of_production')),
    ADD COLUMN old_declining_balance_rate_bps integer
        CHECK (old_declining_balance_rate_bps IS NULL OR old_declining_balance_rate_bps > 0),
    ADD COLUMN new_declining_balance_rate_bps integer
        CHECK (new_declining_balance_rate_bps IS NULL OR new_declining_balance_rate_bps > 0),
    ADD COLUMN old_declining_balance_switch_policy text NOT NULL DEFAULT 'none'
        CHECK (old_declining_balance_switch_policy IN ('none', 'straight_line')),
    ADD COLUMN new_declining_balance_switch_policy text NOT NULL DEFAULT 'none'
        CHECK (new_declining_balance_switch_policy IN ('none', 'straight_line')),
    ADD COLUMN old_total_capacity_units bigint
        CHECK (old_total_capacity_units IS NULL OR old_total_capacity_units > 0),
    ADD COLUMN new_total_capacity_units bigint
        CHECK (new_total_capacity_units IS NULL OR new_total_capacity_units > 0);

-- The projected schedule walks every asset's live postings and the current
-- monthly ledger; this partial index keeps that read cheap without indexing
-- the reversed rows nobody schedules.
CREATE INDEX idx_fixed_asset_depr_live_period
    ON fixed_asset_depreciation_entries (fixed_asset_id, period_key)
    WHERE reversed_at IS NULL AND period_key IS NOT NULL;
