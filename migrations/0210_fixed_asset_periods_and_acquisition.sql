-- ---------------------------------------------------------------------------
-- Fixed assets: canonical depreciation periods, in-service date and the
-- acquisition document — dashboard audit F07/F09.
-- ---------------------------------------------------------------------------
-- 1. A depreciation period was free text unique only as typed, so «۱۴۰۴/۰۱»
--    and «فروردین ۱۴۰۴» depreciated the same month twice. New entries carry
--    `period_key` — the Jalali month as `YYYY-MM` — unique per asset. Rows
--    posted before this migration keep a NULL key; the service derives their
--    month from `entry_date` under the asset's row lock, so a legacy row still
--    blocks a second posting for its month. No legacy row is rewritten.
-- 2. `in_service_date` is when depreciation may start (IAS 16 ¶55: "when it is
--    available for use"), which can be later than the purchase. NULL means the
--    purchase date, which is what every existing asset has always assumed.
-- 3. `acquisition_source` says where the asset's cost sits in the books:
--    'journal' — a posted entry (a purchase or an expense) whose id is
--    `acquisition_entry_id`; 'opening_balance' — carried in by the opening
--    entry; 'unlinked' — nobody has said, which the register↔GL reconciliation
--    reports instead of assuming. Registering an asset still posts nothing, so
--    linking never double-counts the cost.

ALTER TABLE fixed_assets
    ADD COLUMN in_service_date date,
    ADD COLUMN acquisition_source text NOT NULL DEFAULT 'unlinked'
        CHECK (acquisition_source IN ('journal', 'opening_balance', 'unlinked')),
    ADD COLUMN acquisition_entry_id uuid REFERENCES journal_entries(id),
    ADD CONSTRAINT fixed_assets_in_service_after_acquisition
        CHECK (in_service_date IS NULL OR in_service_date >= acquisition_date),
    ADD CONSTRAINT fixed_assets_acquisition_entry_matches_source
        CHECK ((acquisition_source = 'journal') = (acquisition_entry_id IS NOT NULL));

CREATE INDEX idx_fixed_assets_acquisition_entry ON fixed_assets (acquisition_entry_id)
    WHERE acquisition_entry_id IS NOT NULL;

-- The acquisition entry must be this business's own (a composite reference
-- guard; RLS on the reader is not enough, since an id typed into a form is
-- checked here before any policy would hide the row).
CREATE OR REPLACE FUNCTION fixed_asset_acquisition_affinity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.acquisition_entry_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM journal_entries je
         WHERE je.id = NEW.acquisition_entry_id AND je.business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'fixed asset acquisition entry belongs to another business'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_fixed_asset_acquisition_affinity
    BEFORE INSERT OR UPDATE OF acquisition_entry_id, business_id ON fixed_assets
    FOR EACH ROW EXECUTE FUNCTION fixed_asset_acquisition_affinity();

ALTER TABLE fixed_asset_depreciation_entries
    ADD COLUMN period_key text CHECK (period_key IS NULL OR period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

CREATE UNIQUE INDEX uq_fixed_asset_depreciation_period
    ON fixed_asset_depreciation_entries (fixed_asset_id, period_key)
    WHERE period_key IS NOT NULL;
