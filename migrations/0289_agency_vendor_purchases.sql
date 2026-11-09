-- #1128 §D: a supplier quote, its approved purchase commitment, and the
-- resulting client-cost payable. Reuses workspace_approvals and the existing
-- reimbursable-cost/domain-event posting engine. No backfill or ledger INSERTs.
CREATE TABLE agency_vendor_purchases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES ai_projects(id) ON DELETE RESTRICT,
    party_id uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    vendor_party_id uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    purchase_number text NOT NULL CHECK (char_length(purchase_number) BETWEEN 1 AND 24),
    quote_reference text NOT NULL CHECK (char_length(btrim(quote_reference)) BETWEEN 1 AND 200),
    description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
    -- The quoted total in integer rial, not a recomputed tax/fee estimate.
    amount_rial bigint NOT NULL CHECK (amount_rial > 0 AND amount_rial <= 9000000000000000),
    quoted_on date NOT NULL,
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','submitted','approved','rejected','booked')),
    cost_id uuid UNIQUE REFERENCES agency_reimbursable_costs(id) ON DELETE RESTRICT,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, purchase_number),
    CHECK ((status = 'booked') = (cost_id IS NOT NULL))
);
CREATE INDEX idx_agency_vendor_purchases_project ON agency_vendor_purchases (business_id, project_id, status);
ALTER TABLE agency_vendor_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_vendor_purchases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agency_vendor_purchases FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE FUNCTION agency_vendor_purchase_guard() RETURNS trigger
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
            OR (OLD.status='approved' AND NEW.status='booked')
        ) THEN
            RAISE EXCEPTION 'invalid vendor purchase transition' USING ERRCODE='23514';
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
CREATE TRIGGER trg_agency_vendor_purchase_guard BEFORE INSERT OR UPDATE OR DELETE ON agency_vendor_purchases
    FOR EACH ROW EXECUTE FUNCTION agency_vendor_purchase_guard();

ALTER TABLE workspace_approvals DROP CONSTRAINT workspace_approvals_subject_type_check;
ALTER TABLE workspace_approvals ADD CONSTRAINT workspace_approvals_subject_type_check CHECK (subject_type IN (
    'project','task','document','contract','estimate_version','submittal_revision','variation','payment_certificate',
    'material_request','commitment','billing_milestone','change_request','vendor_purchase'
));

ALTER TABLE workspace_activity DROP CONSTRAINT workspace_activity_subject_type_check;
ALTER TABLE workspace_activity ADD CONSTRAINT workspace_activity_subject_type_check CHECK (subject_type IN (
    'project','task','document','contract','approval','member','event','estimate','document_revision','transmittal',
    'rfi','submittal','site_log','site_issue','variation','payment_certificate','material_request','rfq','commitment',
    'billing_milestone','change_request','vendor_purchase'
));
