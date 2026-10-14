-- ===========================================================================
-- 0218_accounting_dimensions_parent_lock.sql — serialises concurrent parent
-- changes within one (business, kind) of accounting_dimension_values, closing
-- a snapshot-isolation write-skew that the deferred cycle trigger alone cannot:
-- under REPEATABLE READ two UPDATEs each see a pre-commit snapshot and cannot
-- detect that the sibling transaction is about to set the reverse parent.
--
-- An xact-level advisory lock keyed on hashtext(business_id) XOR hashtext(kind)
-- forces concurrent reparentings in the same kind to serialise, so the second
-- transaction's deferred cycle walk at COMMIT sees the first one's change and
-- refuses the commit that would close the loop. The lock namespaces to this
-- table via a dedicated tag so it never collides with any other advisory lock
-- the codebase takes.
-- ===========================================================================

CREATE OR REPLACE FUNCTION accounting_dimension_parent_lock() RETURNS trigger AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtext('accounting_dimension_values'),
        hashtext(NEW.business_id::text) # hashtext(NEW.kind)
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounting_dimension_parent_lock ON accounting_dimension_values;
CREATE TRIGGER trg_accounting_dimension_parent_lock
    BEFORE INSERT OR UPDATE OF parent_id ON accounting_dimension_values
    FOR EACH ROW EXECUTE FUNCTION accounting_dimension_parent_lock();
