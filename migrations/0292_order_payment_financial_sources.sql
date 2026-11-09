-- Existing tenders remain explicitly unattributed. Only new routed payments
-- carry the registered identity and the ledger account selected at capture.
ALTER TABLE payments
  ADD COLUMN financial_account_id uuid REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN financial_account_gl_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT payments_financial_account_snapshot
    CHECK ((financial_account_id IS NULL) = (financial_account_gl_id IS NULL));

CREATE INDEX payments_financial_account_source_idx
  ON payments (financial_account_id) WHERE financial_account_id IS NOT NULL;

ALTER TABLE customer_returns
  ADD COLUMN financial_account_id uuid REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN financial_account_gl_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT customer_return_financial_account_snapshot
    CHECK ((financial_account_id IS NULL) = (financial_account_gl_id IS NULL));

CREATE FUNCTION check_payment_financial_account_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD.financial_account_id IS DISTINCT FROM NEW.financial_account_id OR
    OLD.financial_account_gl_id IS DISTINCT FROM NEW.financial_account_gl_id
  ) THEN
    RAISE EXCEPTION 'payment_financial_account_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.financial_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM financial_accounts f
    JOIN locations l ON l.business_id = f.business_id AND l.id = NEW.location_id
    WHERE f.id = NEW.financial_account_id AND f.gl_account_id = NEW.financial_account_gl_id
      AND (f.location_id IS NULL OR f.location_id = l.id)
  ) THEN
    RAISE EXCEPTION 'payment_financial_account_scope' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_financial_account_snapshot_guard
  BEFORE INSERT OR UPDATE OF financial_account_id, financial_account_gl_id, location_id ON payments
  FOR EACH ROW EXECUTE FUNCTION check_payment_financial_account_snapshot();

CREATE TRIGGER customer_return_financial_account_snapshot_guard
  BEFORE INSERT OR UPDATE OF financial_account_id, financial_account_gl_id, location_id ON customer_returns
  FOR EACH ROW EXECUTE FUNCTION check_payment_financial_account_snapshot();

CREATE FUNCTION preserve_routed_financial_account_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (
    OLD.gl_account_id IS DISTINCT FROM NEW.gl_account_id OR OLD.kind IS DISTINCT FROM NEW.kind OR
    OLD.currency_code IS DISTINCT FROM NEW.currency_code OR OLD.location_id IS DISTINCT FROM NEW.location_id OR
    OLD.settlement_account_id IS DISTINCT FROM NEW.settlement_account_id
  ) AND EXISTS (SELECT 1 FROM payments WHERE financial_account_id = OLD.id) THEN
    RAISE EXCEPTION 'routed_financial_account_identity_locked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER routed_financial_account_identity_guard
  BEFORE UPDATE ON financial_accounts FOR EACH ROW EXECUTE FUNCTION preserve_routed_financial_account_identity();
