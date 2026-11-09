-- Existing free-text bank names stay in place until the business confirms a match.
ALTER TABLE financial_accounts
  ADD COLUMN bank_code text,
  ADD CONSTRAINT financial_accounts_bank_code_kind
    CHECK (bank_code IS NULL OR (kind = 'bank' AND bank_code ~ '^[a-z][a-z-]{0,31}$'));
