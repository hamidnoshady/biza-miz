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
-- Manual-mode rows without a code cannot legally exist (there is a CHECK
-- constraint), but if a corrupted dump produces one we leave it alone: the
-- operator chose that number, and a backfill that invents one would disagree
-- with their chart of accounts.
--
-- IMPORTANT: accounting codes are manually-enterable strings up to 24
-- characters. Never cast an arbitrary numeric tail to int4 here: a long manual
-- code must not abort the entire upgrade. Automatic codes have exactly a
-- five-digit tail, so only those tails participate in their namespace; wide
-- manual codes remain valid and unique, but do not move the automatic sequence.
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

        -- Match the application's prefix-keyed allocator. This prevents a
        -- concurrent current-version writer from taking the same candidate;
        -- the collision branch below remains for an older process that does
        -- not yet hold this lock.
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
                   AND accounting_code IS NULL;
                EXIT;
            EXCEPTION WHEN unique_violation THEN
                -- The candidate was taken after our max() read. Move past it;
                -- recomputing the same max can retry the exact same code until
                -- the migration gives up.
                tail := tail + 1;
            END;
        END LOOP;
    END LOOP;
END;
$$;
