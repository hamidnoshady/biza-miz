-- An opaque compare-and-swap revision for the existing automotive price row.
-- Existing vehicles start at zero; no vehicle, cost, price or history is copied.
-- The native price service increments it under the same row lock and transaction
-- as each price/history change. Legacy callers may omit the precondition.
ALTER TABLE automotive_vehicle_attributes
  ADD COLUMN price_revision bigint NOT NULL DEFAULT 0 CHECK (price_revision >= 0);
