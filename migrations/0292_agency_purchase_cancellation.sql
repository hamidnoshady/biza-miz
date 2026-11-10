-- #1128: retire an approved but UNBOOKED commitment without rewriting an
-- approval or touching Accounting. No backfill and no new posting path.
ALTER TABLE agency_vendor_purchases
    ADD COLUMN cancelled_at timestamptz,
    ADD COLUMN cancelled_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    ADD COLUMN cancelled_by_name text NOT NULL DEFAULT '' CHECK (char_length(cancelled_by_name) <= 200),
    ADD COLUMN cancellation_reason text NOT NULL DEFAULT '' CHECK (char_length(cancellation_reason) <= 500);

ALTER TABLE agency_vendor_purchases DROP CONSTRAINT agency_vendor_purchases_status_check;
ALTER TABLE agency_vendor_purchases ADD CONSTRAINT agency_vendor_purchases_status_check
    CHECK (status IN ('draft','submitted','approved','rejected','booked','cancelled'));
ALTER TABLE agency_vendor_purchases ADD CONSTRAINT agency_vendor_purchase_cancellation_metadata CHECK (
    (status='cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
      AND char_length(btrim(cancellation_reason)) > 0)
    OR
    (status<>'cancelled' AND cancelled_at IS NULL AND cancelled_by IS NULL
      AND cancelled_by_name='' AND cancellation_reason='')
);

CREATE OR REPLACE FUNCTION agency_vendor_purchase_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    merging boolean := coalesce(current_setting('app.ledger_party_move',true) = 'on', false);
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'only a draft vendor purchase may be deleted' USING ERRCODE='23514';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN
        RAISE EXCEPTION 'a vendor purchase starts as a draft' USING ERRCODE='23514';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.business_id IS DISTINCT FROM OLD.business_id
           OR NEW.purchase_number IS DISTINCT FROM OLD.purchase_number
           OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
            RAISE EXCEPTION 'vendor purchase identity is immutable' USING ERRCODE='23514';
        END IF;
        IF OLD.status <> 'draft' AND (
            NEW.project_id IS DISTINCT FROM OLD.project_id
            OR NEW.quote_reference IS DISTINCT FROM OLD.quote_reference
            OR NEW.description IS DISTINCT FROM OLD.description
            OR NEW.amount_rial IS DISTINCT FROM OLD.amount_rial
            OR NEW.quoted_on IS DISTINCT FROM OLD.quoted_on
        ) THEN
            RAISE EXCEPTION 'a submitted vendor quote is frozen; record a new quote' USING ERRCODE='23514';
        END IF;
        IF OLD.status <> 'draft' AND NOT merging AND (
            NEW.party_id IS DISTINCT FROM OLD.party_id OR NEW.vendor_party_id IS DISTINCT FROM OLD.vendor_party_id
        ) THEN
            RAISE EXCEPTION 'purchase parties move only through an audited party merge' USING ERRCODE='23514';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
            (OLD.status='draft' AND NEW.status='submitted')
            OR (OLD.status='submitted' AND NEW.status IN ('draft','approved','rejected'))
            OR (OLD.status='approved' AND NEW.status IN ('booked','cancelled'))
        ) THEN
            RAISE EXCEPTION 'invalid vendor purchase transition' USING ERRCODE='23514';
        END IF;
        IF ROW(NEW.cancelled_at,NEW.cancelled_by,NEW.cancelled_by_name,NEW.cancellation_reason)
           IS DISTINCT FROM ROW(OLD.cancelled_at,OLD.cancelled_by,OLD.cancelled_by_name,OLD.cancellation_reason)
           AND NOT (OLD.status='approved' AND NEW.status='cancelled') THEN
            RAISE EXCEPTION 'purchase cancellation history is immutable' USING ERRCODE='23514';
        END IF;
        IF OLD.status='booked' AND NEW.cost_id IS DISTINCT FROM OLD.cost_id THEN
            RAISE EXCEPTION 'a booked vendor purchase keeps its cost link' USING ERRCODE='23514';
        END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ai_projects p WHERE p.id=NEW.project_id AND p.business_id=NEW.business_id)
       OR NOT EXISTS (SELECT 1 FROM parties p WHERE p.id=NEW.party_id AND p.business_id=NEW.business_id)
       OR NOT EXISTS (SELECT 1 FROM parties p WHERE p.id=NEW.vendor_party_id AND p.business_id=NEW.business_id) THEN
        RAISE EXCEPTION 'purchase references must belong to this business' USING ERRCODE='23514';
    END IF;
    -- Check supplier eligibility when a quote is created/submitted or a vendor
    -- attribution changes, not on unrelated historical operations after archive.
    IF TG_OP='INSERT' OR NEW.status='submitted' OR NEW.vendor_party_id IS DISTINCT FROM OLD.vendor_party_id THEN
        IF NOT EXISTS (SELECT 1 FROM parties p WHERE p.id=NEW.vendor_party_id AND p.business_id=NEW.business_id
                       AND p.is_active AND p.merged_into_id IS NULL AND 'supplier'=ANY(p.roles)) THEN
            RAISE EXCEPTION 'purchase vendor must be an active supplier of this business' USING ERRCODE='23514';
        END IF;
    END IF;
    IF NEW.status='approved' AND NOT EXISTS (
        SELECT 1 FROM workspace_approvals a WHERE a.business_id=NEW.business_id
          AND a.subject_type='vendor_purchase' AND a.subject_id=NEW.id AND a.status='approved'
    ) THEN
        RAISE EXCEPTION 'vendor purchase needs a shared-queue approval' USING ERRCODE='23514';
    END IF;
    IF NEW.cost_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM agency_reimbursable_costs c WHERE c.id=NEW.cost_id AND c.business_id=NEW.business_id
          AND c.project_id=NEW.project_id AND c.party_id=NEW.party_id AND c.vendor_party_id=NEW.vendor_party_id
          AND c.amount_rial=NEW.amount_rial AND c.settled_by='payable' AND c.entry_id IS NOT NULL
    ) THEN
        -- Attribution can move register-by-register within an audited merge.
        IF NOT merging THEN
            RAISE EXCEPTION 'purchase cost must be the matching posted payable' USING ERRCODE='23514';
        END IF;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
