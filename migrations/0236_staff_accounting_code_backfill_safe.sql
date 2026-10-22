-- ============================================================================
-- 0236_staff_accounting_code_backfill_safe.sql
--
-- Follow-up to 0231 (issue #1006). Two fixes:
--
--   (1) The 0231 DO block used `substring(...)::integer` on numeric tails,
--       which overflows int4 (2^31-1) on a long all-numeric manual code like
--       `3999999999` and aborts the migration with 22003. Cast to bigint and
--       bound the tail regex to ^[0-9]{1,5}$ so wide manual codes are ignored
--       for max() rather than overflowing.
--   (2) Any database that has already been upgraded to schema >= 0231 but
--       where the backfill did not run (because the migration crashed on a
--       large code, or because 0231 landed in a pre-fix state) gets another
--       pass here. Databases where 0231 completed cleanly simply have no
--       NULL automatic employees left, so this loop is a no-op.
--
-- Runs per-row with a bounded retry on unique_violation, just like 0231.
-- ============================================================================

DO $$
DECLARE
    target record;
    next_code text;
    prefix text;
    tail bigint;
    max_existing bigint;
    attempts integer;
BEGIN
    FOR target IN
        SELECT p.id, p.business_id, p.role
          FROM parties p
         WHERE p.accounting_code IS NULL
           AND p.accounting_code_mode = 'automatic'
         ORDER BY p.business_id, p.role, p.created_at, p.id
    LOOP
        prefix := CASE target.role
                      WHEN 'customer' THEN '1'
                      WHEN 'supplier' THEN '2'
                      ELSE '3'
                  END;

        attempts := 0;
        LOOP
            SELECT COALESCE(
                (SELECT max(
                    CASE WHEN substring(accounting_code FROM length(prefix)+1) ~ '^[0-9]{1,5}$'
                         THEN substring(accounting_code FROM length(prefix)+1)::bigint
                         ELSE 0
                    END)
                   FROM parties
                  WHERE business_id = target.business_id
                    AND accounting_code IS NOT NULL
                    AND accounting_code LIKE prefix || '%'),
                0) INTO max_existing;

            tail := max_existing + 1;
            IF tail > 99999 THEN
                RAISE WARNING 'Cannot assign another % code for business %: 5-digit namespace full. Party % left NULL.',
                    target.role, target.business_id, target.id;
                EXIT;
            END IF;

            next_code := prefix || lpad(tail::text, 5, '0');

            BEGIN
                UPDATE parties
                   SET accounting_code = next_code
                 WHERE id = target.id
                   AND accounting_code IS NULL;
                EXIT;
            EXCEPTION WHEN unique_violation THEN
                attempts := attempts + 1;
                IF attempts >= 50 THEN
                    RAISE WARNING 'Could not assign an accounting code to party % (business %) after 50 attempts; leaving NULL.', target.id, target.business_id;
                    EXIT;
                END IF;
            END;
        END LOOP;
    END LOOP;
END;
$$;
