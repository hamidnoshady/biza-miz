-- Intangible assets — register, amortization and impairment (issue #1326).
--
-- A SEPARATE register from `fixed_assets` on purpose. Tangible assets carry a
-- salvage value, depreciation methods and a cost > 0 check that do not describe
-- an intangible: a software licence has an amortization period, may have an
-- indefinite life, and must never be posted through the fixed-asset control
-- accounts. Mixing the two into one table would silently merge two registers
-- and their GL reconciliation, so this migration only ADDS tables and touches
-- no existing row.
--
-- Every automatic posting these tables produce is journaled by the canonical
-- ledger service (`journal_entries.source_type` + `source_id` +
-- `posting_kind`), and carrying amounts are derived from that posted history —
-- there is no mutable balance column here.

CREATE TABLE intangible_assets (
    id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id                       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id                       uuid REFERENCES locations(id) ON DELETE SET NULL,
    code                              text NOT NULL,
    name                              text NOT NULL,
    description                       text,
    asset_class                       text NOT NULL CHECK (asset_class IN (
                                          'software', 'license', 'patent', 'trademark',
                                          'copyright', 'development', 'other')),
    acquisition_date                  date NOT NULL,
    -- When the asset was ready for its intended use; the amortization schedule
    -- anchors here. Absent = the acquisition date (resolved by the service).
    available_for_use_date            date,
    acquisition_source                text NOT NULL DEFAULT 'purchase' CHECK (acquisition_source IN (
                                          'purchase', 'development', 'contribution', 'other')),
    -- Total capitalized amount: purchase price plus directly attributable cost.
    cost                              bigint NOT NULL CHECK (cost > 0),
    -- The directly attributable part of `cost` (registration fees, testing …).
    directly_attributable_cost        bigint NOT NULL DEFAULT 0
                                          CHECK (directly_attributable_cost >= 0
                                             AND directly_attributable_cost < cost),
    useful_life_type                  text NOT NULL CHECK (useful_life_type IN ('finite', 'indefinite')),
    useful_life_months                integer,
    residual_value                    bigint NOT NULL DEFAULT 0 CHECK (residual_value >= 0),
    -- Account mapping is chosen by the accountant per asset (issue #1326 §1).
    asset_account_id                  uuid REFERENCES accounts(id) ON DELETE SET NULL,
    accumulated_amortization_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    amortization_expense_account_id   uuid REFERENCES accounts(id) ON DELETE SET NULL,
    impairment_loss_account_id        uuid REFERENCES accounts(id) ON DELETE SET NULL,
    accumulated_impairment_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    -- Capitalization policy: who approved treating this as an asset and why.
    capitalized_by                    uuid REFERENCES users(id) ON DELETE SET NULL,
    capitalization_policy_note        text,
    evidence_reference                text,
    custodian_party_id                uuid REFERENCES parties(id) ON DELETE SET NULL,
    notes                             text,
    status                            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed')),
    disposal_kind                     text CHECK (disposal_kind IN ('sale', 'retirement', 'write_off')),
    disposal_date                     date,
    disposal_proceeds                 bigint CHECK (disposal_proceeds IS NULL OR disposal_proceeds >= 0),
    disposal_journal_entry_id         uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    disposal_reason                   text,
    disposed_by                       uuid REFERENCES users(id) ON DELETE SET NULL,
    idempotency_key                   text,
    created_by                        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at                        timestamptz NOT NULL DEFAULT now(),
    updated_at                        timestamptz NOT NULL DEFAULT now(),
    -- A finite life must be stated; an indefinite one must not carry a number
    -- that would make it look amortizable.
    CHECK (
        (useful_life_type = 'finite' AND useful_life_months IS NOT NULL AND useful_life_months > 0)
        OR (useful_life_type = 'indefinite' AND useful_life_months IS NULL)
    ),
    CHECK (residual_value < cost),
    CHECK (disposal_date IS NULL OR status = 'disposed')
);

CREATE INDEX idx_intangible_assets_business ON intangible_assets (business_id);
CREATE INDEX idx_intangible_assets_business_status ON intangible_assets (business_id, status);
CREATE UNIQUE INDEX uq_intangible_assets_code
    ON intangible_assets (business_id, code);
CREATE UNIQUE INDEX uq_intangible_assets_idempotency_key
    ON intangible_assets (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE intangible_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE intangible_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON intangible_assets FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- One row per posted amortization month. The journal entry is linked through
-- `journal_entries.source_type = 'intangible_asset_amortization'` /
-- `source_id = id`, exactly as depreciation does, so the register never stores
-- a second accounting truth. Reversal marks the row (never deletes it) and the
-- month may then be posted again — hence the partial unique index.
-- ---------------------------------------------------------------------------
CREATE TABLE intangible_asset_amortization_entries (
    id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    intangible_asset_id          uuid NOT NULL REFERENCES intangible_assets(id) ON DELETE CASCADE,
    period_key                   text NOT NULL CHECK (period_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    period_label                 text NOT NULL,
    entry_date                   date NOT NULL,
    amount                       bigint NOT NULL CHECK (amount > 0),
    reversed_at                  timestamptz,
    reversed_by                  uuid REFERENCES users(id) ON DELETE SET NULL,
    reversal_reason              text,
    reversal_journal_entry_id    uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    created_by                   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_intangible_amortization_asset
    ON intangible_asset_amortization_entries (intangible_asset_id);
CREATE UNIQUE INDEX uq_intangible_amortization_period
    ON intangible_asset_amortization_entries (intangible_asset_id, period_key)
    WHERE reversed_at IS NULL;
CREATE UNIQUE INDEX uq_intangible_amortization_reversal
    ON intangible_asset_amortization_entries (reversal_journal_entry_id)
    WHERE reversal_journal_entry_id IS NOT NULL;

ALTER TABLE intangible_asset_amortization_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE intangible_asset_amortization_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON intangible_asset_amortization_entries FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM intangible_assets a
         WHERE a.id = intangible_asset_amortization_entries.intangible_asset_id
           AND a.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM intangible_assets a
         WHERE a.id = intangible_asset_amortization_entries.intangible_asset_id
           AND a.business_id = app_current_business()));

-- ---------------------------------------------------------------------------
-- Impairment assessments (issue #1326 §3). An assessment records the evidence
-- and the recoverable amount the accountant used; the posted amount is the
-- journaled effect. A reversal points back at the assessment it undoes, so the
-- history reads as a sequence of approved judgements — never a rewritten one.
-- ---------------------------------------------------------------------------
CREATE TABLE intangible_asset_impairments (
    id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    intangible_asset_id          uuid NOT NULL REFERENCES intangible_assets(id) ON DELETE CASCADE,
    assessment_date              date NOT NULL,
    effective_date               date NOT NULL,
    recoverable_amount           bigint NOT NULL CHECK (recoverable_amount >= 0),
    carrying_amount_before       bigint NOT NULL CHECK (carrying_amount_before >= 0),
    impairment_amount            bigint NOT NULL CHECK (impairment_amount > 0),
    reason                       text NOT NULL,
    evidence_reference           text,
    journal_entry_id             uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    reversal_of                  uuid REFERENCES intangible_asset_impairments(id) ON DELETE SET NULL,
    reversed_at                  timestamptz,
    reversed_by                  uuid REFERENCES users(id) ON DELETE SET NULL,
    reversal_reason              text,
    reversal_journal_entry_id    uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    assessed_by                  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at                   timestamptz NOT NULL DEFAULT now(),
    -- A reversal row names the assessment it undoes and carries that reversal's
    -- journal entry; a first assessment carries neither.
    CHECK (reversal_of IS NULL OR reversal_journal_entry_id IS NOT NULL)
);

CREATE INDEX idx_intangible_impairments_asset
    ON intangible_asset_impairments (intangible_asset_id, effective_date);

ALTER TABLE intangible_asset_impairments ENABLE ROW LEVEL SECURITY;
ALTER TABLE intangible_asset_impairments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON intangible_asset_impairments FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM intangible_assets a
         WHERE a.id = intangible_asset_impairments.intangible_asset_id
           AND a.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM intangible_assets a
         WHERE a.id = intangible_asset_impairments.intangible_asset_id
           AND a.business_id = app_current_business()));
