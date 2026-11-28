-- Intangible-asset prospective estimate changes (issue #1326, Linear ESH-163).
--
-- A change to an intangible's remaining useful life or residual value is an
-- accounting estimate change: it applies to the current and future periods
-- only. Previously posted amortization and its journal entries stay exactly as
-- they were, so this migration only ADDS a history table — it rewrites no
-- existing row and no existing voucher.
--
-- Each row is the accountant's approved decision, with the previous and new
-- values, the effective date/month, the remaining amortizable base the new
-- estimate leaves, the reason and the evidence reference. New amortization is
-- priced from `remaining_base` over `new_useful_life_months`, snapshotted here
-- so a later change cannot retroactively reinterpret an earlier one.

CREATE TABLE intangible_asset_estimate_changes (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    intangible_asset_id             uuid NOT NULL REFERENCES intangible_assets(id) ON DELETE CASCADE,
    effective_date                  date NOT NULL,
    effective_period_key            text NOT NULL CHECK (effective_period_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    previous_useful_life_type       text NOT NULL CHECK (previous_useful_life_type IN ('finite', 'indefinite')),
    previous_useful_life_months     integer,
    previous_residual_value         bigint NOT NULL CHECK (previous_residual_value >= 0),
    new_useful_life_type            text NOT NULL CHECK (new_useful_life_type IN ('finite', 'indefinite')),
    new_useful_life_months          integer,
    new_residual_value              bigint NOT NULL CHECK (new_residual_value >= 0),
    -- What the change leaves to amortize and how long it now has to take.
    remaining_base                  bigint NOT NULL CHECK (remaining_base >= 0),
    remaining_life_months           integer,
    -- The live history at the moment of the decision: an audit fact, not a
    -- second accounting truth. Future postings read the live ledger rows.
    accumulated_amortization_at_change bigint NOT NULL DEFAULT 0
                                          CHECK (accumulated_amortization_at_change >= 0),
    accumulated_impairment_at_change   bigint NOT NULL DEFAULT 0
                                          CHECK (accumulated_impairment_at_change >= 0),
    periods_posted_at_change        integer NOT NULL DEFAULT 0 CHECK (periods_posted_at_change >= 0),
    posted_period_keys              text[] NOT NULL DEFAULT '{}',
    reason                          text NOT NULL,
    evidence_reference              text,
    approved_by                     uuid REFERENCES users(id) ON DELETE SET NULL,
    changed_by                      uuid REFERENCES users(id) ON DELETE SET NULL,
    idempotency_key                 text,
    created_at                      timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (new_useful_life_type = 'finite' AND new_useful_life_months IS NOT NULL AND new_useful_life_months > 0)
        OR (new_useful_life_type = 'indefinite' AND new_useful_life_months IS NULL)
    ),
    CHECK (
        (previous_useful_life_type = 'finite' AND previous_useful_life_months IS NOT NULL)
        OR (previous_useful_life_type = 'indefinite' AND previous_useful_life_months IS NULL)
    )
);

CREATE INDEX idx_intangible_estimate_changes_asset
    ON intangible_asset_estimate_changes (intangible_asset_id, effective_period_key);
CREATE UNIQUE INDEX uq_intangible_estimate_changes_idempotency
    ON intangible_asset_estimate_changes (intangible_asset_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE intangible_asset_estimate_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE intangible_asset_estimate_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON intangible_asset_estimate_changes FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM intangible_assets a
         WHERE a.id = intangible_asset_estimate_changes.intangible_asset_id
           AND a.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM intangible_assets a
         WHERE a.id = intangible_asset_estimate_changes.intangible_asset_id
           AND a.business_id = app_current_business()));
