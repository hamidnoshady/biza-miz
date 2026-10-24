-- ============================================================================
-- 0249_staff_accounting_code_backfill_resilient.sql
--
-- Issue #1006 — convergence pass for installations that ran an earlier staff
-- accounting-code backfill while a second application process was allocating
-- parties. The older retry loop could retry an already-colliding candidate and
-- eventually leave an Automatic party without a code.
--
-- This is intentionally idempotent: it only considers Automatic parties whose
-- code is still NULL. It shares the application's prefix-keyed advisory lock,
-- scans every party in the business that owns that prefix (manual codes are
-- business-wide too), ignores numeric manual tails wider than the five-digit
-- automatic namespace, and advances the candidate after a real unique
-- collision. Existing codes, including manual codes and already assigned staff
-- codes, are never changed.
-- ============================================================================

DO $$
DECLARE
    target record;
    next_code text;
    prefix text;
    tail bigint;
    max_existing bigint;
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

        PERFORM pg_advisory_xact_lock(
            hashtext('party-accounting-code'),
            hashtext(target.business_id::text || ':' || prefix)
        );

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
        LOOP
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
                   AND accounting_code IS NULL
                   AND accounting_code_mode = 'automatic';
                EXIT;
            EXCEPTION WHEN unique_violation THEN
                tail := tail + 1;
            END;
        END LOOP;
    END LOOP;
END;
$$;
