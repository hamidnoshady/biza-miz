-- ---------------------------------------------------------------------------
-- 0211_fixed_asset_lifecycle.sql — issue #833: the fixed-asset register grows
-- a real lifecycle and the accounting-integrity backstops the audit asked for.
--
--   1. Reversal, not deletion: a posted depreciation entry can be reversed
--      (reversed_at/reversal_reason/… — the same shape payroll_runs and
--      journal_entries already use) but never removed. Accumulated
--      depreciation is reconstructed from *live* rows only (reversed_at IS
--      NULL), so a reversal restores the asset's schedule exactly: the month
--      can be posted again, and the final-period rounding correction still
--      lands on whatever is genuinely left.
--
--   2. Source-history integrity: the depreciation rows' FK to their asset
--      flips from ON DELETE CASCADE to ON DELETE RESTRICT. An asset that
--      caused accounting can no longer disappear underneath its journal
--      entries; the service refuses (under the row lock) long before the
--      database would have to.
--
--   3. Lifecycle: status active/disposed/retired plus the disposal facts
--      (kind, date, proceeds, the journal entry, who, why). «fully
--      depreciated» stays derived — never a stored shadow of the entries —
--      and archived_at is separate from status because archiving is a
--      housekeeping act, not an accounting event.
--
--   4. Prospective estimate changes and branch transfers get their own
--      audited history tables rather than silent edits of the asset row.
--      Both snapshot what the change means for the remaining schedule so
--      future depreciation is computed from facts, not re-derived folklore.
--
--   5. Master data an asset register needs: stable per-business code,
--      category, serial number, vendor and custodian (references into the
--      one `parties` table — never a second supplier/person system), the
--      purchase document reference, notes, and the fixed-asset account the
--      cost sits in (the 1500–1599 block the register already reconciles
--      against). Plus an idempotency key so a double-submit cannot register
--      one machine twice.
--
-- No existing row is rewritten: every asset starts as 'active' with no
-- disposal, and NULL code/category/vendor simply mean «not recorded».
-- ---------------------------------------------------------------------------

-- 1. Reversal columns on the posted entries ---------------------------------

ALTER TABLE fixed_asset_depreciation_entries
    ADD COLUMN reversed_at              timestamptz,
    ADD COLUMN reversed_by              uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN reversal_reason          text,
    ADD COLUMN reversal_journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL;

-- The journal link of a reversal points at the mirror entry; one reversal
-- per source entry, enforced where the link is written.
CREATE UNIQUE INDEX uq_fixed_asset_depreciation_reversal
    ON fixed_asset_depreciation_entries (reversal_journal_entry_id)
    WHERE reversal_journal_entry_id IS NOT NULL;

-- A reversed posting is history, not a schedule entry: the corrected re-post
-- of the same month must be allowed, so a month is unique per asset only
-- among its LIVE (non-reversed) rows. 0210's index covered reversed rows too.
DROP INDEX IF EXISTS uq_fixed_asset_depreciation_period;
CREATE UNIQUE INDEX uq_fixed_asset_depreciation_period
    ON fixed_asset_depreciation_entries (fixed_asset_id, period_key)
    WHERE period_key IS NOT NULL AND reversed_at IS NULL;

-- Labels are presentation, not identity — 0210 made period_key the identity.
-- The original UNIQUE (fixed_asset_id, period_label) from 0058 has to go too:
-- a corrected re-post after a reversal regenerates the same default label
-- («فروردین 1404»), and that constraint would refuse it.
ALTER TABLE fixed_asset_depreciation_entries
    DROP CONSTRAINT IF EXISTS fixed_asset_depreciation_entrie_fixed_asset_id_period_label_key;

-- 2. Source-history integrity: never cascade away posted rows ---------------

ALTER TABLE fixed_asset_depreciation_entries
    DROP CONSTRAINT fixed_asset_depreciation_entries_fixed_asset_id_fkey;
ALTER TABLE fixed_asset_depreciation_entries
    ADD CONSTRAINT fixed_asset_depreciation_entries_fixed_asset_id_fkey
    FOREIGN KEY (fixed_asset_id) REFERENCES fixed_assets(id) ON DELETE RESTRICT;

-- 3. Lifecycle + disposal + archive on the asset -----------------------------
--
-- «fully depreciated» and «archived» are deliberately *not* statuses: the
-- first is derived from the live entries (a stored copy would be a shadow
-- column the register's own reconstruction rule forbids), the second is
-- housekeeping (archived_at) rather than an accounting event. The accounting
-- lifecycle is exactly active → disposed, and every disposal — sale,
-- retirement or write-off — posts the removal entry that flips it.

ALTER TABLE fixed_assets
    ADD COLUMN status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disposed')),
    ADD COLUMN disposal_kind text
        CHECK (disposal_kind IN ('sale', 'retirement', 'write_off')),
    ADD COLUMN disposal_date date,
    ADD COLUMN disposal_proceeds bigint CHECK (disposal_proceeds IS NULL OR disposal_proceeds >= 0),
    ADD COLUMN disposal_journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    ADD COLUMN disposal_reason text,
    ADD COLUMN disposed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN archived_at timestamptz,
    ADD COLUMN archived_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN archive_reason text,
    ADD CONSTRAINT fixed_assets_disposal_shape CHECK (
        (status = 'disposed') = (disposal_journal_entry_id IS NOT NULL AND disposal_kind IS NOT NULL AND disposal_date IS NOT NULL)
    ),
    -- A sale is a sale because something was received for it; retirement and
    -- write-off are the zero-proceeds exits and must not carry proceeds.
    ADD CONSTRAINT fixed_assets_disposal_proceeds_shape CHECK (
        disposal_kind IS DISTINCT FROM 'sale' OR disposal_proceeds > 0
    ),
    ADD CONSTRAINT fixed_assets_disposal_zero_proceeds_shape CHECK (
        disposal_kind IS NULL OR disposal_kind = 'sale' OR COALESCE(disposal_proceeds, 0) = 0
    );

-- 4. Estimate changes and transfers — audited, never in-place rewrites ------

CREATE TABLE fixed_asset_estimate_changes (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    fixed_asset_id          uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE RESTRICT,
    changed_at              timestamptz NOT NULL DEFAULT now(),
    -- The Jalali `YYYY-MM` from which the new estimate applies: the first
    -- period posted after the change. Snapshot, not a live re-derivation.
    effective_period_key    text NOT NULL,
    old_useful_life_months  integer NOT NULL CHECK (old_useful_life_months > 0),
    new_useful_life_months  integer NOT NULL CHECK (new_useful_life_months > 0),
    old_salvage_value       bigint NOT NULL CHECK (old_salvage_value >= 0),
    new_salvage_value       bigint NOT NULL CHECK (new_salvage_value >= 0),
    -- Live depreciation periods already posted when the change was made.
    periods_posted_at_change integer NOT NULL CHECK (periods_posted_at_change >= 0),
    -- The remaining schedule the change froze: depreciable amount left and
    -- the months it now has to fit into (0 = due in full on the next period).
    remaining_life_months   integer NOT NULL CHECK (remaining_life_months >= 0),
    remaining_base          bigint NOT NULL CHECK (remaining_base >= 0),
    -- Live accumulated depreciation when the change was made — what the
    -- remaining_base was computed after, so future amounts are facts.
    accumulated_at_change   bigint NOT NULL CHECK (accumulated_at_change >= 0),
    reason                  text NOT NULL,
    changed_by              uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fixed_asset_estimate_changes_asset ON fixed_asset_estimate_changes (fixed_asset_id);

ALTER TABLE fixed_asset_estimate_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_asset_estimate_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fixed_asset_estimate_changes FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM fixed_assets fa
         WHERE fa.id = fixed_asset_estimate_changes.fixed_asset_id
           AND fa.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM fixed_assets fa
         WHERE fa.id = fixed_asset_estimate_changes.fixed_asset_id
           AND fa.business_id = app_current_business()));

CREATE TABLE fixed_asset_transfers (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    fixed_asset_id   uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE RESTRICT,
    from_location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
    to_location_id   uuid REFERENCES locations(id) ON DELETE SET NULL,
    effective_date   date NOT NULL,
    reason           text NOT NULL,
    transferred_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (from_location_id IS DISTINCT FROM to_location_id)
);
CREATE INDEX idx_fixed_asset_transfers_asset ON fixed_asset_transfers (fixed_asset_id);

ALTER TABLE fixed_asset_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_asset_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fixed_asset_transfers FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM fixed_assets fa
         WHERE fa.id = fixed_asset_transfers.fixed_asset_id
           AND fa.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM fixed_assets fa
         WHERE fa.id = fixed_asset_transfers.fixed_asset_id
           AND fa.business_id = app_current_business()));

-- 5. Master data, accounting classification, idempotency --------------------

ALTER TABLE fixed_assets
    ADD COLUMN code               text,
    ADD COLUMN category           text,
    ADD COLUMN serial_number      text,
    ADD COLUMN vendor_party_id    uuid REFERENCES parties(id) ON DELETE SET NULL,
    ADD COLUMN custodian_party_id uuid REFERENCES parties(id) ON DELETE SET NULL,
    ADD COLUMN purchase_reference text,
    ADD COLUMN notes              text,
    ADD COLUMN asset_account_id   uuid REFERENCES accounts(id) ON DELETE SET NULL,
    ADD COLUMN idempotency_key    text;

-- The stable tag is per business; a repeated create key returns the original
-- asset, so the index is the database's own word on "already registered".
CREATE UNIQUE INDEX uq_fixed_assets_code
    ON fixed_assets (business_id, code) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX uq_fixed_assets_idempotency_key
    ON fixed_assets (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Composite reference guards, same discipline as the acquisition-entry
-- affinity trigger in 0210: an id typed into a form is checked before any
-- RLS policy on the reader would hide the row, and the vendor/custodian/
-- account must be this business's own.
CREATE OR REPLACE FUNCTION fixed_asset_party_affinity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.vendor_party_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM parties p
         WHERE p.id = NEW.vendor_party_id AND p.business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'fixed asset vendor belongs to another business'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.custodian_party_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM parties p
         WHERE p.id = NEW.custodian_party_id AND p.business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'fixed asset custodian belongs to another business'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.asset_account_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM accounts a
         WHERE a.id = NEW.asset_account_id AND a.business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'fixed asset account belongs to another business'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_fixed_asset_party_affinity
    BEFORE INSERT OR UPDATE OF vendor_party_id, custodian_party_id, asset_account_id, business_id
    ON fixed_assets
    FOR EACH ROW EXECUTE FUNCTION fixed_asset_party_affinity();

-- A transfer's from/to locations must both be this business's, whichever side
-- of the asset's own business_id the row is written from.
CREATE OR REPLACE FUNCTION fixed_asset_transfer_affinity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM fixed_assets fa WHERE fa.id = NEW.fixed_asset_id) THEN
        RETURN NEW;
    END IF;
    IF NEW.from_location_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM locations l
          JOIN fixed_assets fa ON fa.id = NEW.fixed_asset_id
         WHERE l.id = NEW.from_location_id AND l.business_id = fa.business_id
    ) THEN
        RAISE EXCEPTION 'transfer source location belongs to another business'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.to_location_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM locations l
          JOIN fixed_assets fa ON fa.id = NEW.fixed_asset_id
         WHERE l.id = NEW.to_location_id AND l.business_id = fa.business_id
    ) THEN
        RAISE EXCEPTION 'transfer target location belongs to another business'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_fixed_asset_transfer_affinity
    BEFORE INSERT OR UPDATE OF from_location_id, to_location_id, fixed_asset_id
    ON fixed_asset_transfers
    FOR EACH ROW EXECUTE FUNCTION fixed_asset_transfer_affinity();
