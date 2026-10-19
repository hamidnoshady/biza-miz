-- ============================================================================
-- 0231_staff_accounting_code_backfill.sql
--
-- Issue #1006 — staff (کارکنان) show «—» in کد حسابداری.
--
-- Root cause: `updateParty` in src/lib/parties-service.ts wrote NULL to
-- `accounting_code` on every Automatic-mode save (a phone fix, a rename from
-- the personnel-file sync). The first personnel-file propagation gave each new
-- hire a code; the next touch of the same member wiped it. So every staff
-- member that the membership -> personnel-file sync ever revisited ended up
-- with no number.
--
-- This migration backfills the missing codes using the same prefix scheme the
-- service uses — 1 for customers, 2 for suppliers, 3 for personnel, padded to
-- five digits — assigning the next free number per (business, role) in
-- created_at order.
--
-- The loop is deliberately per-row: a set-based UPDATE with row_number() can
-- race with itself inside the statement (CTEs all read the same snapshot, so
-- the NOT EXISTS guard sees none of the codes the same statement is writing
-- and unique-index violations appear). Iterating one row at a time, choosing
-- max()+1 per read, lets the UNIQUE index arbitrate collisions the exact way
-- the application code does.
--
-- Manual-mode rows without a code cannot legally exist (there is a CHECK
-- constraint), but if a corrupted dump produces one we leave it alone: the
-- operator chose that number, and a backfill that invents one would disagree
-- with their chart of accounts.
-- ============================================================================

DO $$
DECLARE
    target record;
    next_code text;
    prefix text;
    tail integer;
    max_existing integer;
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

        -- Find the next free tail for this (business, role). Same shape as
        -- nextAccountingCode() in src/lib/parties.ts — filter by prefix, take
        -- max numeric tail, add one. Retry a few times in case a concurrent
        -- transaction (an import, an online migration) grabs our pick.
        attempts := 0;
        LOOP
            SELECT COALESCE(
                (SELECT max(
                    CASE WHEN substring(accounting_code FROM length(prefix)+1) ~ '^[0-9]+$'
                         THEN substring(accounting_code FROM length(prefix)+1)::integer
                         ELSE 0
                    END)
                   FROM parties
                  WHERE business_id = target.business_id
                    AND accounting_code IS NOT NULL
                    AND accounting_code LIKE prefix || '%'),
                0) INTO max_existing;

            tail := max_existing + 1;
            next_code := prefix || lpad(tail::text, 5, '0');

            BEGIN
                UPDATE parties
                   SET accounting_code = next_code
                 WHERE id = target.id
                   AND accounting_code IS NULL;
                EXIT; -- success
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
