-- ---------------------------------------------------------------------------
-- Keep item_batches.total_value_rial true after a batch's quantity changes.
--
-- Migration 0236 added `item_batches.total_value_rial` and `item_stock.
-- total_value_rial` to carry the *exact* Rial total per lot, so a non-integer
-- average (1 @ 100 + 1 @ 101 → 100.5) no longer drifts from the GL posting,
-- and documented the column as "the authoritative exact total per lot". It
-- backfilled existing rows and left it at that: **no write path maintains it.**
--
-- Every consumption path in the application decrements `item_batches.quantity`
-- on its own (`retail-batch-inventory.ts` FEFO sale, transfers, write-offs;
-- `retail-stock-service.ts` supplier returns; `cosmetics-service.ts`), and
-- only `retail-warehouse-document-service.ts` remembered to move the value
-- alongside it. The readers, meanwhile, prefer the stale column:
--
--   UPDATE item_batches SET quantity = quantity - 4      -- value unchanged
--   SELECT COALESCE(SUM(total_value_rial), …)            -- still the old total
--
-- so a lot holding 1 unit at 20,000 kept reporting the 5 units it used to
-- hold, and the weighted average came out at 25,000 instead of 11,667.
-- `integration/retail-batch-inventory.integration.test.ts` caught it: the
-- two failures there reproduce identically on main before this change.
--
-- Fixing the twelve call sites one by one would leave the thirteenth free to
-- reintroduce the drift, so the invariant is enforced where it cannot be
-- skipped: a BEFORE INSERT OR UPDATE trigger on the batch itself.
--
-- Semantics
--   * INSERT  — a row that carries a unit cost but no explicit total gets
--               round(quantity × unit_cost).
--   * UPDATE  — when the caller leaves total_value_rial alone and moves the
--               quantity, the total moves by the exact value of those units
--               (round(delta × unit_cost)), never by a re-averaged figure.
--               When the caller *does* set the column explicitly (the
--               warehouse-document path above), the trigger stands aside.
--   * A repriced lot with an unchanged quantity is revalued to
--               round(quantity × unit_cost).
--   * Lots with no known cost keep a NULL total: unknown stays unknown.
--
-- Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION item_batches_maintain_total_value() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.total_value_rial IS NULL AND NEW.unit_cost IS NOT NULL THEN
            NEW.total_value_rial := round(NEW.quantity * NEW.unit_cost)::bigint;
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE. `NEW.total_value_rial IS NOT DISTINCT FROM OLD.total_value_rial`
    -- means the statement did not touch the column, so the trigger owns it.
    IF NEW.total_value_rial IS NOT DISTINCT FROM OLD.total_value_rial THEN
        -- A lot with no cost basis on either side keeps a NULL total: "unknown"
        -- must not be rewritten as "worth nothing".
        IF NEW.unit_cost IS NULL AND OLD.unit_cost IS NULL AND OLD.total_value_rial IS NULL THEN
            RETURN NEW;
        END IF;

        IF NEW.quantity IS DISTINCT FROM OLD.quantity THEN
            NEW.total_value_rial := GREATEST(
                COALESCE(
                    OLD.total_value_rial,
                    round(OLD.quantity * COALESCE(OLD.unit_cost, 0))::bigint,
                    0
                )
                + round(
                    (NEW.quantity - OLD.quantity)
                    * COALESCE(NEW.unit_cost, OLD.unit_cost, 0)
                )::bigint,
                0
            );
        ELSIF NEW.unit_cost IS DISTINCT FROM OLD.unit_cost AND NEW.unit_cost IS NOT NULL THEN
            NEW.total_value_rial := round(NEW.quantity * NEW.unit_cost)::bigint;
        END IF;
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_item_batches_total_value ON item_batches;
CREATE TRIGGER trg_item_batches_total_value
    BEFORE INSERT OR UPDATE ON item_batches
    FOR EACH ROW
    EXECUTE FUNCTION item_batches_maintain_total_value();

-- Bring the rows written before this trigger into line. Every lot is re-derived
-- from its current quantity and unit cost; lots whose cost is unknown keep a
-- NULL total. This is the same rule the trigger applies, run once.
UPDATE item_batches
   SET total_value_rial = CASE
           WHEN unit_cost IS NOT NULL THEN round(quantity * unit_cost)::bigint
           ELSE NULL
       END
 WHERE total_value_rial IS DISTINCT FROM (CASE
           WHEN unit_cost IS NOT NULL THEN round(quantity * unit_cost)::bigint
           ELSE NULL
       END);

-- item_stock.total_value_rial is a rollup of its batches; recompute it from
-- the corrected batch totals so the two cannot disagree after this migration.
UPDATE item_stock s
   SET total_value_rial = COALESCE(
           (SELECT sum(b.total_value_rial)::bigint FROM item_batches b WHERE b.item_id = s.item_id),
           CASE WHEN s.unit_cost IS NOT NULL THEN round(s.quantity * s.unit_cost)::bigint ELSE 0 END
       )
 WHERE s.total_value_rial IS DISTINCT FROM COALESCE(
           (SELECT sum(b.total_value_rial)::bigint FROM item_batches b WHERE b.item_id = s.item_id),
           CASE WHEN s.unit_cost IS NOT NULL THEN round(s.quantity * s.unit_cost)::bigint ELSE 0 END
       );
