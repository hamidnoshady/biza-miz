-- ESH-154: add payment provenance without deriving it from historical GL legs.
ALTER TABLE journal_lines ADD COLUMN financial_account_id uuid REFERENCES financial_accounts(id) ON DELETE RESTRICT;
CREATE INDEX idx_journal_lines_financial_account ON journal_lines (financial_account_id, entry_id)
  WHERE financial_account_id IS NOT NULL;

ALTER TABLE expenses ADD COLUMN financial_account_id uuid REFERENCES financial_accounts(id) ON DELETE RESTRICT;
ALTER TABLE ar_receipts ADD COLUMN financial_account_id uuid REFERENCES financial_accounts(id) ON DELETE RESTRICT;
ALTER TABLE ap_payments ADD COLUMN financial_account_id uuid REFERENCES financial_accounts(id) ON DELETE RESTRICT;
ALTER TABLE cheque_events ADD COLUMN financial_account_id uuid REFERENCES financial_accounts(id) ON DELETE RESTRICT;
ALTER TABLE payroll_advances ADD COLUMN financial_account_id uuid REFERENCES financial_accounts(id) ON DELETE RESTRICT;
ALTER TABLE payroll_runs ADD COLUMN financial_account_id uuid REFERENCES financial_accounts(id) ON DELETE RESTRICT;
ALTER TABLE commission_settlement_payouts ADD COLUMN financial_account_id uuid REFERENCES financial_accounts(id) ON DELETE RESTRICT;
ALTER TABLE purchases ADD COLUMN financial_account_id uuid REFERENCES financial_accounts(id) ON DELETE RESTRICT;
ALTER TABLE item_purchases ADD COLUMN financial_account_id uuid REFERENCES financial_accounts(id) ON DELETE RESTRICT;

-- An explicit journal reference must be for the same tenant and GL. Active
-- state, branch and currency are checked for new payments by their resolver;
-- a reversal can still name the original account after it is archived.
CREATE FUNCTION guard_journal_financial_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.financial_account_id IS DISTINCT FROM OLD.financial_account_id THEN
    RAISE EXCEPTION 'journal line financial facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.financial_account_id IS NOT NULL THEN
    PERFORM 1 FROM financial_accounts fa
      JOIN journal_entries je ON je.id = NEW.entry_id AND je.business_id = fa.business_id
      WHERE fa.id = NEW.financial_account_id AND fa.gl_account_id = NEW.account_id
      FOR SHARE OF fa;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'journal_financial_account_mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_journal_financial_account
  BEFORE INSERT OR UPDATE OF financial_account_id, account_id, entry_id ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION guard_journal_financial_account();

CREATE FUNCTION guard_posted_financial_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.gl_account_id, NEW.kind, NEW.currency_code, NEW.business_id)
     IS DISTINCT FROM (OLD.gl_account_id, OLD.kind, OLD.currency_code, OLD.business_id)
     AND EXISTS (SELECT 1 FROM journal_lines WHERE financial_account_id = OLD.id) THEN
    RAISE EXCEPTION 'financial_account_identity_locked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_posted_financial_account_identity
  BEFORE UPDATE OF gl_account_id, kind, currency_code, business_id ON financial_accounts
  FOR EACH ROW EXECUTE FUNCTION guard_posted_financial_account_identity();
