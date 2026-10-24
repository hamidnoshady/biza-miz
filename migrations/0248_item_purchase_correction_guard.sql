-- Issue #915 phase 3 — posted retail purchases are append-only at the
-- DATABASE level, not just by application convention.
--
-- Product decision (recorded in ISSUE_915_PLAN.md): a posted retail purchase
-- receipt is an accounting document. Corrections happen through NEW
-- documents — a supplier return (stock + ledger reversal, already ceilinged
-- against the original receipt) or a periodic credit note — never by editing
-- or deleting the posted receipt. The only legitimate UPDATE the engine
-- performs is the receive transaction finalising `total` on the row it just
-- inserted (retail-stock-service.ts), which is the 0 → computed-total write.
--
-- The trigger enforces exactly that:
--   * UPDATE is allowed only while the row's total is still 0 (the in-flight
--     insert) and ONLY the total changes — compared via to_jsonb so every
--     other column, including ones added by future migrations, is covered;
--   * DELETE from a TENANT-SCOPED session (app.business_id set — i.e. any
--     request that came through the application's tenant pool) is rejected.
--     Cascaded deletes (a business/location being removed) fire this trigger
--     from inside the FK's internal trigger where pg_trigger_depth() > 1 and
--     pass through, and maintenance sessions without a tenant GUC (platform
--     scripts, test harnesses) stay able to clean up — the guard is aimed at
--     the application layer, where a destructive "edit purchase" feature
--     could otherwise drift in.
--
-- `status = 'cancelled'` exists in the 0084 CHECK but no flow sets it; under
-- this guard a future cancel feature must ship its own migration relaxing
-- the trigger deliberately — it cannot drift in as an ad-hoc UPDATE.

CREATE OR REPLACE FUNCTION item_purchases_block_correction() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.total = 0 AND (to_jsonb(NEW) - 'total') = (to_jsonb(OLD) - 'total') THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'item_purchase_correction_forbidden: posted retail purchases are corrected by supplier return or credit note, never edited (issue #915)'
            USING ERRCODE = 'raise_exception';
    END IF;
    -- TG_OP = 'DELETE': depth 1 is a direct DELETE (anything deeper is a
    -- foreign-key cascade, e.g. business removal, and must proceed).
    IF pg_trigger_depth() = 1 AND app_current_business() IS NOT NULL THEN
        RAISE EXCEPTION 'item_purchase_delete_forbidden: posted retail purchases are never deleted; cancel their effect with a supplier return or credit note (issue #915)'
            USING ERRCODE = 'raise_exception';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_item_purchases_block_correction ON item_purchases;
CREATE TRIGGER trg_item_purchases_block_correction
    BEFORE UPDATE OR DELETE ON item_purchases
    FOR EACH ROW EXECUTE FUNCTION item_purchases_block_correction();
