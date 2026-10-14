-- Issue #830 (reconciliation audit) — ownership integrity for bank
-- reconciliation, enforced by the database rather than by whoever happens to
-- be writing.
--
-- `bank_reconciliations` has always had two separate foreign keys, one to
-- `businesses` and one to `accounts`, and nothing structural said the two had
-- to agree: a row could point at business A and at business B's bank account
-- and every constraint would pass. `bank_reconciliation_lines` was one step
-- further from the invariant — it references a reconciliation and a journal
-- line, and neither reference says the line is a posting *on the account being
-- reconciled*, or even in the same business.
--
-- `reconciliation-service.ts` checks all of this on every path it owns, and
-- its integration tests pin the checks. But the service is not the only writer
-- a schema has: an import, a maintenance script, a future service or a person
-- in `psql` can each insert a row that satisfies every foreign key and breaks
-- the reconciliation anyway — and a claim on the wrong account is silent
-- corruption, because the line then counts toward a balance it has nothing to
-- do with and can never be claimed by the reconciliation that should have it.
--
-- Same shape and same errcode as migration 0210's
-- `fixed_asset_acquisition_affinity()`: a BEFORE trigger, `23514`, and a
-- message that names the invariant rather than the column.
--
-- Composite foreign keys were the alternative and do not fit: they need the
-- child row to carry the parent's tenant column, and `journal_lines` has no
-- `business_id` of its own — it inherits it from `journal_entries`, so the
-- check has to be a join, and a join is a trigger.

CREATE OR REPLACE FUNCTION bank_reconciliation_account_affinity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM accounts a
         WHERE a.id = NEW.account_id AND a.business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'bank reconciliation account belongs to another business'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bank_reconciliation_account_affinity
    BEFORE INSERT OR UPDATE OF account_id, business_id ON bank_reconciliations
    FOR EACH ROW EXECUTE FUNCTION bank_reconciliation_account_affinity();

CREATE OR REPLACE FUNCTION bank_reconciliation_line_affinity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    reconciliation record;
BEGIN
    SELECT r.business_id, r.account_id INTO reconciliation
      FROM bank_reconciliations r WHERE r.id = NEW.reconciliation_id;

    -- No reconciliation row: the foreign key on reconciliation_id answers that
    -- one, and answers it with a better message than this trigger could.
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
         WHERE jl.id = NEW.journal_line_id
           AND jl.account_id = reconciliation.account_id
           AND je.business_id = reconciliation.business_id
    ) THEN
        RAISE EXCEPTION 'bank reconciliation line is not a posting on the reconciled account of the reconciled business'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bank_reconciliation_line_affinity
    BEFORE INSERT ON bank_reconciliation_lines
    FOR EACH ROW EXECUTE FUNCTION bank_reconciliation_line_affinity();
