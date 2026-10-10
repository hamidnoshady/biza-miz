-- ===========================================================================
-- 0217_accounting_dimensions_concurrency.sql — concurrency hardening for the
-- accounting dimension model (issue #868).
--
-- A **deferred** cycle check that runs AFTER the transaction commits its
-- changes. The 0216 per-row BEFORE trigger catches an immediate self-cycle
-- (A becoming its own parent) but it fires on a snapshot taken before any
-- concurrent sibling transaction commits. A deferred CONSTRAINT TRIGGER that
-- re-runs the ancestor walk at COMMIT time catches cross-row cycles by
-- examining the post-commit state of the modified row. This pairs with the
-- xact-level advisory lock added in 0218 to fully prevent mutual-loop
-- write-skew.
-- ===========================================================================

CREATE OR REPLACE FUNCTION accounting_dimension_no_cycle_deferred() RETURNS trigger AS $$
BEGIN
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF EXISTS (
        WITH RECURSIVE ancestors AS (
            SELECT id, parent_id FROM accounting_dimension_values WHERE id = NEW.parent_id
            UNION ALL
            SELECT v.id, v.parent_id
              FROM accounting_dimension_values v
              JOIN ancestors a ON v.id = a.parent_id
        )
        SELECT 1 FROM ancestors WHERE id = NEW.id
    ) THEN
        RAISE EXCEPTION 'dimension_cycle' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounting_dimension_no_cycle_deferred ON accounting_dimension_values;
CREATE CONSTRAINT TRIGGER trg_accounting_dimension_no_cycle_deferred
    AFTER INSERT OR UPDATE OF parent_id ON accounting_dimension_values
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION accounting_dimension_no_cycle_deferred();
