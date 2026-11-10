-- Preserve existing reconciliations on their original GL, without assigning
-- pooled history to a bank or terminal. Only newly attributable records get
-- the optional financial account link.
ALTER TABLE bank_reconciliations
  ADD COLUMN financial_account_id uuid REFERENCES financial_accounts(id) ON DELETE RESTRICT;

CREATE INDEX idx_bank_reconciliations_financial_account
  ON bank_reconciliations(financial_account_id)
  WHERE financial_account_id IS NOT NULL;

CREATE FUNCTION bank_reconciliation_financial_account_affinity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND
       (NEW.financial_account_id, NEW.account_id, NEW.business_id) IS DISTINCT FROM
       (OLD.financial_account_id, OLD.account_id, OLD.business_id) THEN
        RAISE EXCEPTION 'bank reconciliation account attribution is immutable'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.financial_account_id IS NOT NULL THEN
        PERFORM 1 FROM financial_accounts fa
         WHERE fa.id = NEW.financial_account_id
           AND fa.business_id = NEW.business_id AND fa.gl_account_id = NEW.account_id
         FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'bank reconciliation financial account and GL account must agree'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bank_reconciliation_financial_account_affinity
    BEFORE INSERT OR UPDATE OF financial_account_id, account_id, business_id ON bank_reconciliations
    FOR EACH ROW EXECUTE FUNCTION bank_reconciliation_financial_account_affinity();

CREATE FUNCTION financial_account_keep_reconciled_gl() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.business_id, NEW.gl_account_id, NEW.kind, NEW.currency_code) IS DISTINCT FROM
       (OLD.business_id, OLD.gl_account_id, OLD.kind, OLD.currency_code)
       AND EXISTS (
           SELECT 1 FROM bank_reconciliations r WHERE r.financial_account_id = OLD.id
       ) THEN
        RAISE EXCEPTION 'financial account reconciliation fixes its GL identity'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_financial_account_keep_reconciled_gl
    BEFORE UPDATE OF business_id, gl_account_id, kind, currency_code ON financial_accounts
    FOR EACH ROW EXECUTE FUNCTION financial_account_keep_reconciled_gl();
