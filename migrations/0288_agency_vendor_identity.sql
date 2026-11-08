-- #1128 §D: a vendor is a canonical party, not an inferred text match.
-- Additive and nullable: historical free-text documents remain unchanged.
ALTER TABLE agency_reimbursable_costs
    ADD COLUMN vendor_party_id uuid REFERENCES parties(id) ON DELETE RESTRICT;
ALTER TABLE agency_vendor_settlements
    ADD COLUMN vendor_party_id uuid REFERENCES parties(id) ON DELETE RESTRICT;
CREATE INDEX idx_agency_cost_vendor_party ON agency_reimbursable_costs (business_id, vendor_party_id)
    WHERE vendor_party_id IS NOT NULL;
CREATE INDEX idx_agency_settlement_vendor_party ON agency_vendor_settlements (business_id, vendor_party_id)
    WHERE vendor_party_id IS NOT NULL;

-- These are additional guards, not replacements for the cost/recharge/payment
-- guards from 0280/0284/0287. All prior accounting protections remain in force.
CREATE FUNCTION agency_vendor_identity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    changed boolean;
    merging boolean := current_setting('app.ledger_party_move', true) = 'on';
BEGIN
    IF TG_OP = 'INSERT' THEN
        changed := NEW.vendor_party_id IS NOT NULL;
    ELSE
        changed := NEW.vendor_party_id IS DISTINCT FROM OLD.vendor_party_id
                   OR NEW.business_id IS DISTINCT FROM OLD.business_id;
        IF OLD.entry_id IS NOT NULL
           AND NEW.vendor_party_id IS DISTINCT FROM OLD.vendor_party_id
           AND NOT coalesce(merging, false) THEN
            RAISE EXCEPTION 'posted vendor attribution moves only through an audited party merge'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    -- Check at assignment, not on unrelated note edits: archiving a supplier
    -- later must not make its historical documents unwritable.
    IF changed AND NEW.vendor_party_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM parties p
         WHERE p.id = NEW.vendor_party_id AND p.business_id = NEW.business_id
           AND p.is_active AND p.merged_into_id IS NULL
           AND 'supplier' = ANY(p.roles)
    ) THEN
        RAISE EXCEPTION 'vendor must be an active supplier party of this business'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_agency_cost_vendor_identity
    BEFORE INSERT OR UPDATE ON agency_reimbursable_costs
    FOR EACH ROW EXECUTE FUNCTION agency_vendor_identity_guard();
CREATE TRIGGER trg_agency_settlement_vendor_identity
    BEFORE INSERT OR UPDATE ON agency_vendor_settlements
    FOR EACH ROW EXECUTE FUNCTION agency_vendor_identity_guard();

-- A newly attached payment must carry exactly the same vendor identity. This
-- includes NULL: linked-party and legacy text documents cannot be mixed.
-- During an audited party merge both registers move in the same transaction;
-- no payment link changes, so the transient order of those updates is harmless.
CREATE FUNCTION agency_cost_payment_vendor_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.settlement_id IS NOT NULL
       AND NEW.settlement_id IS DISTINCT FROM OLD.settlement_id
       AND NOT EXISTS (
           SELECT 1 FROM agency_vendor_settlements s
            WHERE s.id = NEW.settlement_id AND s.business_id = NEW.business_id
              AND s.vendor_party_id IS NOT DISTINCT FROM NEW.vendor_party_id
       ) THEN
        RAISE EXCEPTION 'payment and cost must name the same vendor party'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_agency_cost_payment_vendor
    BEFORE UPDATE ON agency_reimbursable_costs
    FOR EACH ROW EXECUTE FUNCTION agency_cost_payment_vendor_guard();

COMMENT ON COLUMN agency_reimbursable_costs.vendor_party_id IS
    'Canonical supplier identity, optional for legacy/free-text costs. vendor_name remains the historical document snapshot; no name-based backfill or inference.';
COMMENT ON COLUMN agency_vendor_settlements.vendor_party_id IS
    'Canonical vendor inherited from selected costs, never guessed from a name. A payment cannot mix distinct supplier parties or linked and unlinked costs.';
