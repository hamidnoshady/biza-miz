-- ============================================================================
-- 0201_aec_procurement.sql — issue #799 Wave 9 (§18 procurement for contractor
-- profiles).
--
-- §18's flow is: Requirement → Material Request → RFQ → Supplier Quotations →
-- Comparison → Approval → Purchase Commitment → Delivery → Invoice/Accounting.
-- Eight tables, in that order:
--
--   1. `aec_material_requests`          — §18's requirement/material request,
--                                         numbered `MR-001` per project
--   2. `aec_material_request_lines`     — what is being asked for, linked to the
--                                         BOQ/work package where it exists
--   3. `aec_rfqs`                       — the request for quotation, numbered
--                                         `RFQ-001` per project, raised from a
--                                         request or on its own for a package
--   4. `aec_rfq_suppliers`              — who was invited to quote
--   5. `aec_supplier_quotations`        — what each supplier offered (amount,
--                                         lead time, validity) — the comparison
--                                         is a read over these, not a table
--   6. `aec_commitments`                — the approved purchase commitment:
--                                         `PO-` for a purchase, `SC-` for a
--                                         subcontract package
--   7. `aec_commitment_deliveries`      — §18's delivery tracking, one row per
--                                         receipt against a commitment
--   8. `aec_procurement_events`         — §33's immutable trail for all three
--                                         registers ("procurement approval")
--
-- SIX RULES THIS FILE EXISTS TO ENFORCE, all in the database rather than only in
-- the service:
--
--   * SUPPLIERS ARE `parties`, AND NOTHING HERE IS A STOCK PURCHASE. §18 is
--     explicit on both counts: "Suppliers remain `parties`", and the flow ends at
--     "Invoice/Accounting" — so this register references a party for the
--     supplier and never touches the F&B `purchases`/`suppliers`/`items` model.
--     There is no quantity on a commitment's money either: the commitment is a
--     commercial promise for a value, and what arrived is the delivery record.
--     (An AEC tenant has no products workspace at all — Wave 1's decision — so
--     the stock model is not merely unused here, it is unreachable.)
--   * A SUBMITTED REQUEST AND AN ISSUED RFQ ARE FROZEN. From `submitted` on, a
--     material request's content — title, scope, the date it is needed and every
--     line — accepts no change; an RFQ freezes the same way once `issued`,
--     because the suppliers are quoting what was sent them. Both can be
--     cancelled, and a rejected request is edited by taking it back to draft.
--   * A QUOTATION IS WHAT A SUPPLIER OFFERED. Once a quotation has been
--     shortlisted, selected or declined it is history; a revised offer from the
--     same supplier in a new round is a new RFQ. One offer per supplier per RFQ
--     is a UNIQUE index, so the comparison cannot quietly hold two.
--   * THE SELECTION IS THE APPROVED COMMITMENT. There is no "select a supplier"
--     act separate from the commitment: the commitment names the quotation it
--     was raised from, and it exists as committed money only once approved
--     through `workspace_approvals`. A supplier therefore cannot be selected
--     without an approved award, and a commitment cannot be approved without a
--     value, a supplier and the date the goods are expected — the three things
--     §18's "expected delivery" and "delay warning" are measured from.
--   * DELIVERIES ARE TRACKED AGAINST A COMMITMENT, AND CANNOT PRECEDE IT. A
--     delivery row may only be written while the commitment is `approved` or
--     `delivered`, and neither the commitment's content nor its delivery rows
--     may change once it is `closed` or `cancelled` — the settlement is
--     Accounting's from there.
--   * ACCOUNTING KEEPS THE POSTED MONEY, AGAIN. No table here stores an invoice,
--     an AP balance or a payment: a commitment is what we *promised*, the
--     delivery is what *arrived*, and the invoice/payment is the ledger's (§18's
--     last step). The cockpit's committed cost is read from this register, and
--     its actual cost still comes from `journal_lines`, exactly as Wave 8 left
--     it.
--
-- Tenancy and immutability follow 0194/0196–0200 exactly: composite foreign keys
-- to `(business_id, …)`, triggers for the references that cannot use one (users,
-- parties, nullable parents), and FORCE RLS with the standard `tenant_isolation`
-- policy on every table.
--
-- Known follow-up (Wave 11), same as 0196–0200: an approved commitment cannot be
-- deleted, so a project teardown that cascades through one is refused by these
-- guards. Projects are archived rather than deleted today.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. §18's requirement — the material request
-- ---------------------------------------------------------------------------
CREATE TABLE aec_material_requests (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id       uuid NOT NULL,
    request_number   text NOT NULL CHECK (btrim(request_number) <> ''),
    title            text NOT NULL CHECK (btrim(title) <> ''),
    -- §18's "project/work-package allocation": the package this requirement
    -- belongs to, as a free label — the BOQ's own `work_package` column is where
    -- the priced lines live, and a request may precede the BOQ.
    work_package     text NOT NULL DEFAULT '',
    description      text NOT NULL DEFAULT '',
    priority         text NOT NULL DEFAULT 'normal'
                         CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    -- The date the site needs it by. §18's "delay warning" measures the
    -- commitment's delivery against the date the supplier was given; this one
    -- measures the procurement itself.
    required_by      date,
    status           text NOT NULL DEFAULT 'draft'
                         CHECK (status IN (
                             'draft', 'submitted', 'approved', 'rejected', 'closed', 'cancelled'
                         )),
    submitted_date   date,
    approved_date    date,
    closed_date      date,
    created_by       uuid,
    created_by_name  text NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    -- §18's request is a requirement somebody signed off: an approved one has a
    -- date, and a request that is being acted on has been submitted.
    CHECK (status NOT IN ('submitted', 'approved', 'rejected', 'closed') OR submitted_date IS NOT NULL),
    CHECK (status NOT IN ('approved', 'closed') OR approved_date IS NOT NULL),
    CHECK (status <> 'closed' OR closed_date IS NOT NULL),
    UNIQUE (business_id, project_id, request_number),
    UNIQUE (business_id, id),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_material_requests_project
    ON aec_material_requests (business_id, project_id, status);
CREATE INDEX idx_aec_material_requests_open
    ON aec_material_requests (business_id, status) WHERE status IN ('draft', 'submitted', 'approved');

ALTER TABLE aec_material_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_material_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_material_requests FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE aec_material_request_lines (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    request_id   uuid NOT NULL,
    -- §18's "build procurement around approved requirements/BOQ where
    -- appropriate": a line may point at the BOQ item it satisfies, or stand on
    -- its own for a requirement the estimate does not price (site consumables).
    boq_item_id  uuid REFERENCES aec_boq_items(id) ON DELETE SET NULL,
    description  text NOT NULL CHECK (btrim(description) <> ''),
    unit         text NOT NULL DEFAULT '',
    quantity     numeric(14, 3) NOT NULL CHECK (quantity > 0),
    position     integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (business_id, request_id)
        REFERENCES aec_material_requests (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_material_request_lines_request
    ON aec_material_request_lines (request_id, position);
CREATE INDEX idx_aec_material_request_lines_boq
    ON aec_material_request_lines (boq_item_id) WHERE boq_item_id IS NOT NULL;

ALTER TABLE aec_material_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_material_request_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_material_request_lines FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 2. §18's RFQ and the suppliers invited to it
-- ---------------------------------------------------------------------------
CREATE TABLE aec_rfqs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id          uuid NOT NULL,
    -- Nullable: an RFQ may be raised on its own for a work package the client
    -- ordered directly, with no material request behind it (0167 made the same
    -- call for a contract that precedes its project).
    request_id          uuid,
    rfq_number          text NOT NULL CHECK (btrim(rfq_number) <> ''),
    title               text NOT NULL CHECK (btrim(title) <> ''),
    scope               text NOT NULL DEFAULT '',
    status              text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'issued', 'closed', 'cancelled')),
    -- §18's "expected delivery" period the quotations are asked to beat, and the
    -- date offers are due by.
    due_date            date,
    response_due        date,
    issued_date         date,
    closed_date         date,
    created_by          uuid,
    created_by_name     text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (status <> 'issued' OR issued_date IS NOT NULL),
    CHECK (status <> 'closed' OR closed_date IS NOT NULL),
    UNIQUE (business_id, project_id, rfq_number),
    UNIQUE (business_id, id),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, request_id)
        REFERENCES aec_material_requests (business_id, id) ON DELETE SET NULL
);
CREATE INDEX idx_aec_rfqs_project ON aec_rfqs (business_id, project_id, status);
CREATE INDEX idx_aec_rfqs_request
    ON aec_rfqs (request_id) WHERE request_id IS NOT NULL;

ALTER TABLE aec_rfqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_rfqs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_rfqs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE aec_rfq_suppliers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    rfq_id      uuid NOT NULL,
    party_id    uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    note        text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, rfq_id, party_id),
    FOREIGN KEY (business_id, rfq_id)
        REFERENCES aec_rfqs (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_rfq_suppliers_rfq ON aec_rfq_suppliers (rfq_id);
CREATE INDEX idx_aec_rfq_suppliers_party ON aec_rfq_suppliers (party_id);

ALTER TABLE aec_rfq_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_rfq_suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_rfq_suppliers FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. §18's supplier quotations — the comparison is a read over these
-- ---------------------------------------------------------------------------
CREATE TABLE aec_supplier_quotations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    rfq_id        uuid NOT NULL,
    party_id      uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    -- The figure the supplier offered, in the same integer Rial as every money
    -- column in the product, plus what a comparison sheet actually compares:
    -- price, lead time, how long the offer stands, and a note.
    amount_rial   bigint NOT NULL CHECK (amount_rial >= 0),
    lead_days     integer CHECK (lead_days IS NULL OR lead_days >= 0),
    validity_date date,
    note          text NOT NULL DEFAULT '',
    status        text NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received', 'shortlisted', 'selected', 'declined')),
    received_date date NOT NULL,
    created_by    uuid,
    created_by_name text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- One offer per supplier per RFQ. A revised offer is a new round, not a
    -- second row.
    UNIQUE (business_id, rfq_id, party_id),
    UNIQUE (business_id, id),
    FOREIGN KEY (business_id, rfq_id)
        REFERENCES aec_rfqs (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_supplier_quotations_rfq ON aec_supplier_quotations (rfq_id, amount_rial);
CREATE INDEX idx_aec_supplier_quotations_party ON aec_supplier_quotations (party_id);

ALTER TABLE aec_supplier_quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_supplier_quotations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_supplier_quotations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 4. §18's purchase commitment — the award, and the money the cockpit counts
-- ---------------------------------------------------------------------------
CREATE TABLE aec_commitments (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id            uuid NOT NULL,
    -- §18 lists "purchase commitment" and the subcontractor capability next to
    -- it; both are the same record — money promised to a party for goods or for
    -- a package of work — so the kind is a column rather than a second register,
    -- and the number prefix follows the kind (`PO-001` / `SC-001`).
    kind                  text NOT NULL DEFAULT 'purchase'
                              CHECK (kind IN ('purchase', 'subcontract')),
    commitment_number     text NOT NULL CHECK (btrim(commitment_number) <> ''),
    supplier_party_id     uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    -- Where the award came from. All three are optional: a direct award to a
    -- single supplier is a legitimate purchase, and §18's flow is the ordinary
    -- path rather than the only one.
    request_id            uuid,
    rfq_id                uuid,
    quotation_id          uuid,
    -- The signed subcontract, when one is drawn up. §17's AEC block lives on
    -- `workspace_contracts`, so a formal subcontract is that record and this is
    -- the link — the commitment is the money, the contract is the document.
    contract_id           uuid,
    title                 text NOT NULL CHECK (btrim(title) <> ''),
    scope                 text NOT NULL DEFAULT '',
    work_package          text NOT NULL DEFAULT '',
    value_rial            bigint NOT NULL DEFAULT 0 CHECK (value_rial >= 0),
    expected_delivery_date date,
    status                text NOT NULL DEFAULT 'draft'
                              CHECK (status IN (
                                  'draft', 'submitted', 'approved', 'rejected', 'delivered',
                                  'closed', 'cancelled'
                              )),
    submitted_date        date,
    approved_date         date,
    delivered_date        date,
    closed_date           date,
    created_by            uuid,
    created_by_name       text NOT NULL DEFAULT '',
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    -- A commitment that is being acted on names its three facts: how much, to
    -- whom, and when it is expected. §18's "delay warning" is measured from the
    -- third, and the cockpit's committed cost from the first.
    CHECK (status NOT IN ('submitted', 'approved', 'rejected', 'delivered', 'closed')
           OR (value_rial > 0 AND expected_delivery_date IS NOT NULL)),
    CHECK (status NOT IN ('submitted', 'approved', 'rejected', 'delivered', 'closed')
           OR submitted_date IS NOT NULL),
    CHECK (status NOT IN ('approved', 'delivered', 'closed') OR approved_date IS NOT NULL),
    CHECK (status NOT IN ('delivered', 'closed') OR delivered_date IS NOT NULL),
    CHECK (status <> 'closed' OR closed_date IS NOT NULL),
    -- The number prefix and the kind agree, so the register cannot hold a
    -- purchase order numbered `SC-`.
    CHECK ((kind = 'subcontract' AND commitment_number LIKE 'SC-%')
           OR (kind = 'purchase' AND commitment_number LIKE 'PO-%')),
    UNIQUE (business_id, project_id, commitment_number),
    UNIQUE (business_id, id),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, request_id)
        REFERENCES aec_material_requests (business_id, id) ON DELETE SET NULL,
    FOREIGN KEY (business_id, rfq_id)
        REFERENCES aec_rfqs (business_id, id) ON DELETE SET NULL,
    FOREIGN KEY (business_id, quotation_id)
        REFERENCES aec_supplier_quotations (business_id, id) ON DELETE SET NULL,
    FOREIGN KEY (business_id, contract_id)
        REFERENCES workspace_contracts (business_id, id) ON DELETE SET NULL
);
CREATE INDEX idx_aec_commitments_project
    ON aec_commitments (business_id, project_id, status);
CREATE INDEX idx_aec_commitments_supplier ON aec_commitments (supplier_party_id);
CREATE INDEX idx_aec_commitments_rfq ON aec_commitments (rfq_id) WHERE rfq_id IS NOT NULL;
CREATE INDEX idx_aec_commitments_contract ON aec_commitments (contract_id) WHERE contract_id IS NOT NULL;
-- "Which delivery is late?" — the one read §22's Procurement Delays widget, §23's
-- tool and §29's reminder share. A partial index because the four statuses it
-- excludes are the ones that cannot be late.
CREATE INDEX idx_aec_commitments_open_delivery
    ON aec_commitments (business_id, expected_delivery_date)
 WHERE status IN ('approved', 'delivered');

ALTER TABLE aec_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_commitments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_commitments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 5. §18's delivery tracking
-- ---------------------------------------------------------------------------
CREATE TABLE aec_commitment_deliveries (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    commitment_id uuid NOT NULL,
    delivered_on  date NOT NULL,
    note          text NOT NULL DEFAULT '',
    received_by   uuid,
    received_by_name text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (business_id, commitment_id)
        REFERENCES aec_commitments (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_commitment_deliveries_commitment
    ON aec_commitment_deliveries (commitment_id, delivered_on);

ALTER TABLE aec_commitment_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_commitment_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_commitment_deliveries FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 6. §33 — the procurement trail
-- ---------------------------------------------------------------------------
-- One table for the three registers, like `aec_commercial_events` for the two
-- commercial ones: the same kind of entry (an action, a summary, who did it,
-- when), and the three nullable foreign keys plus the CHECK say which record each
-- row belongs to. §33 names "procurement approval" specifically; the request, the
-- RFQ and the delivery are here for the same reason the registers above them are.
CREATE TABLE aec_procurement_events (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id        uuid NOT NULL,
    request_id        uuid,
    rfq_id            uuid,
    commitment_id     uuid,
    action            text NOT NULL CHECK (action IN (
        'created', 'updated', 'submitted', 'approved', 'rejected', 'issued',
        'closed', 'cancelled', 'reopened', 'quoted', 'shortlisted', 'selected',
        'declined', 'delivered', 'deleted'
    )),
    summary           text NOT NULL DEFAULT '',
    actor_id          uuid,
    actor_name        text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    CHECK ((request_id IS NOT NULL)::integer + (rfq_id IS NOT NULL)::integer
           + (commitment_id IS NOT NULL)::integer = 1),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, request_id)
        REFERENCES aec_material_requests (business_id, id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, rfq_id)
        REFERENCES aec_rfqs (business_id, id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, commitment_id)
        REFERENCES aec_commitments (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_aec_procurement_events_request
    ON aec_procurement_events (request_id, created_at DESC) WHERE request_id IS NOT NULL;
CREATE INDEX idx_aec_procurement_events_rfq
    ON aec_procurement_events (rfq_id, created_at DESC) WHERE rfq_id IS NOT NULL;
CREATE INDEX idx_aec_procurement_events_commitment
    ON aec_procurement_events (commitment_id, created_at DESC) WHERE commitment_id IS NOT NULL;
CREATE INDEX idx_aec_procurement_events_project
    ON aec_procurement_events (project_id, created_at DESC);

ALTER TABLE aec_procurement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE aec_procurement_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aec_procurement_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 7. The files are the platform's files (the fifth register)
-- ---------------------------------------------------------------------------
-- A commitment's signed order or subcontract — and the supplier's own quote when
-- it arrives as a scan — is a `workspace_documents` row, as every other
-- register's evidence is. One new nullable column, and the trigger grows one
-- branch.
ALTER TABLE workspace_documents
    ADD COLUMN IF NOT EXISTS commitment_id uuid;
CREATE INDEX IF NOT EXISTS idx_workspace_documents_commitment
    ON workspace_documents (commitment_id) WHERE commitment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION aec_assert_attachment_owned() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
    owner_project  uuid;
    target_project uuid;
BEGIN
    IF NEW.project_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM ai_projects WHERE id = NEW.project_id;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'workspace_documents: project belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.rfi_id IS NOT NULL THEN
        SELECT business_id, project_id INTO owner_business, owner_project
          FROM aec_rfis WHERE id = NEW.rfi_id;
        target_project := owner_project;
    ELSIF NEW.submittal_id IS NOT NULL THEN
        SELECT business_id, project_id INTO owner_business, owner_project
          FROM aec_submittals WHERE id = NEW.submittal_id;
        target_project := owner_project;
    ELSIF NEW.site_log_id IS NOT NULL THEN
        SELECT business_id, project_id INTO owner_business, owner_project
          FROM aec_site_logs WHERE id = NEW.site_log_id;
        target_project := owner_project;
    ELSIF NEW.site_issue_id IS NOT NULL THEN
        SELECT business_id, project_id INTO owner_business, owner_project
          FROM aec_site_issues WHERE id = NEW.site_issue_id;
        target_project := owner_project;
    ELSIF NEW.variation_id IS NOT NULL THEN
        SELECT business_id, project_id INTO owner_business, owner_project
          FROM aec_variations WHERE id = NEW.variation_id;
        target_project := owner_project;
    ELSIF NEW.payment_certificate_id IS NOT NULL THEN
        SELECT business_id, project_id INTO owner_business, owner_project
          FROM aec_payment_certificates WHERE id = NEW.payment_certificate_id;
        target_project := owner_project;
    ELSIF NEW.commitment_id IS NOT NULL THEN
        SELECT business_id, project_id INTO owner_business, owner_project
          FROM aec_commitments WHERE id = NEW.commitment_id;
        target_project := owner_project;
    ELSE
        RETURN NEW;
    END IF;

    IF owner_business IS NULL THEN
        RAISE EXCEPTION 'workspace_documents: the AEC record does not exist'
            USING ERRCODE = '23514';
    END IF;
    IF owner_business <> NEW.business_id THEN
        RAISE EXCEPTION 'workspace_documents: the AEC record belongs to another business'
            USING ERRCODE = '23514';
    END IF;
    -- The document must belong to the same project as the register row it
    -- evidences (0263's rule, carried forward: a foreign project's file is not
    -- evidence for this one).
    IF target_project IS NOT NULL AND NEW.project_id IS DISTINCT FROM target_project THEN
        RAISE EXCEPTION 'workspace_documents: the AEC record belongs to another project'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_workspace_documents_aec_attachment ON workspace_documents;
CREATE TRIGGER trg_workspace_documents_aec_attachment
    BEFORE INSERT OR UPDATE ON workspace_documents
    FOR EACH ROW EXECUTE FUNCTION aec_assert_attachment_owned();

-- ---------------------------------------------------------------------------
-- 8. The references that cannot use a composite key
-- ---------------------------------------------------------------------------
-- Same three shapes as 0196–0200: a `users` or `parties` reference (no
-- `business_id` in the unique key they expose), and the ownership half of a
-- nullable parent that is deliberately `ON DELETE SET NULL` (a composite key
-- would null `business_id` with it).
CREATE OR REPLACE FUNCTION aec_assert_procurement_references_owned() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
    -- One function is attached to eight tables, and PL/pgSQL resolves `NEW.col`
    -- when it executes the expression rather than when it takes the branch — so
    -- `NEW.created_by` in the first condition raises 42703 on
    -- `aec_material_request_lines`, which has no such column, even though the
    -- branch that reads it would never run there. Every field read from the
    -- *condition* therefore goes through this JSON view of the row; the bodies
    -- below may use `NEW.col` freely, because a body only runs for the table its
    -- own `ELSIF` matched.
    payload jsonb := to_jsonb(NEW);
BEGIN
    IF TG_TABLE_NAME = 'aec_material_requests'
       AND NULLIF(payload ->> 'created_by', '') IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM users
         WHERE id = (payload ->> 'created_by')::uuid;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'aec_material_requests: creator belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'aec_material_request_lines'
          AND NULLIF(payload ->> 'boq_item_id', '') IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM aec_boq_items
         WHERE id = (payload ->> 'boq_item_id')::uuid;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'aec_material_request_lines: BOQ item belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'aec_rfqs' THEN
        IF NEW.created_by IS NOT NULL THEN
            SELECT business_id INTO owner_business FROM users WHERE id = NEW.created_by;
            IF owner_business IS DISTINCT FROM NEW.business_id THEN
                RAISE EXCEPTION 'aec_rfqs: creator belongs to another business'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        -- The request it was raised from must be the same project's: an RFQ for
        -- another project's requirement would quote the wrong scope.
        IF NEW.request_id IS NOT NULL THEN
            SELECT business_id INTO owner_business FROM aec_material_requests WHERE id = NEW.request_id;
            IF owner_business IS DISTINCT FROM NEW.business_id THEN
                RAISE EXCEPTION 'aec_rfqs: material request belongs to another business'
                    USING ERRCODE = '23514';
            END IF;
            PERFORM 1 FROM aec_material_requests
             WHERE id = NEW.request_id AND project_id <> NEW.project_id;
            IF FOUND THEN
                RAISE EXCEPTION 'aec_rfqs: material request belongs to another project'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
    ELSIF TG_TABLE_NAME IN ('aec_rfq_suppliers', 'aec_supplier_quotations')
          AND NULLIF(payload ->> 'party_id', '') IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM parties
         WHERE id = (payload ->> 'party_id')::uuid;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'aec procurement: supplier belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'aec_commitments' THEN
        SELECT business_id INTO owner_business FROM parties WHERE id = NEW.supplier_party_id;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'aec_commitments: supplier belongs to another business'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.created_by IS NOT NULL THEN
            SELECT business_id INTO owner_business FROM users WHERE id = NEW.created_by;
            IF owner_business IS DISTINCT FROM NEW.business_id THEN
                RAISE EXCEPTION 'aec_commitments: creator belongs to another business'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        -- Whatever the award came from, it must be this project's, and the
        -- quotation must be the RFQ's own — an award quoting another tender's
        -- offer is the mistake this register exists to make impossible.
        IF NEW.request_id IS NOT NULL THEN
            PERFORM 1 FROM aec_material_requests
             WHERE id = NEW.request_id AND (business_id <> NEW.business_id OR project_id <> NEW.project_id);
            IF FOUND THEN
                RAISE EXCEPTION 'aec_commitments: material request belongs to another project or business'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF NEW.rfq_id IS NOT NULL THEN
            PERFORM 1 FROM aec_rfqs
             WHERE id = NEW.rfq_id AND (business_id <> NEW.business_id OR project_id <> NEW.project_id);
            IF FOUND THEN
                RAISE EXCEPTION 'aec_commitments: RFQ belongs to another project or business'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF NEW.quotation_id IS NOT NULL THEN
            PERFORM 1 FROM aec_supplier_quotations
             WHERE id = NEW.quotation_id
               AND (business_id <> NEW.business_id
                    OR (NEW.rfq_id IS NOT NULL AND rfq_id <> NEW.rfq_id)
                    OR party_id <> NEW.supplier_party_id);
            IF FOUND THEN
                RAISE EXCEPTION 'aec_commitments: quotation is not this supplier''s offer on this RFQ'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF NEW.contract_id IS NOT NULL THEN
            PERFORM 1 FROM workspace_contracts
             WHERE id = NEW.contract_id
               AND (business_id <> NEW.business_id
                    OR (project_id IS NOT NULL AND project_id <> NEW.project_id));
            IF FOUND THEN
                RAISE EXCEPTION 'aec_commitments: contract belongs to another project or business'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
    ELSIF TG_TABLE_NAME = 'aec_commitment_deliveries'
          AND NULLIF(payload ->> 'received_by', '') IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM users
         WHERE id = (payload ->> 'received_by')::uuid;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'aec_commitment_deliveries: receiver belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'aec_procurement_events' THEN
        IF NEW.request_id IS NOT NULL THEN
            SELECT business_id INTO owner_business FROM aec_material_requests WHERE id = NEW.request_id;
        ELSIF NEW.rfq_id IS NOT NULL THEN
            SELECT business_id INTO owner_business FROM aec_rfqs WHERE id = NEW.rfq_id;
        ELSE
            SELECT business_id INTO owner_business FROM aec_commitments WHERE id = NEW.commitment_id;
        END IF;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'aec_procurement_events: subject belongs to another business'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.actor_id IS NOT NULL THEN
            SELECT business_id INTO owner_business FROM users WHERE id = NEW.actor_id;
            IF owner_business IS DISTINCT FROM NEW.business_id THEN
                RAISE EXCEPTION 'aec_procurement_events: actor belongs to another business'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_aec_material_requests_references
    BEFORE INSERT OR UPDATE ON aec_material_requests
    FOR EACH ROW EXECUTE FUNCTION aec_assert_procurement_references_owned();
CREATE TRIGGER trg_aec_material_request_lines_references
    BEFORE INSERT OR UPDATE ON aec_material_request_lines
    FOR EACH ROW EXECUTE FUNCTION aec_assert_procurement_references_owned();
CREATE TRIGGER trg_aec_rfqs_references
    BEFORE INSERT OR UPDATE ON aec_rfqs
    FOR EACH ROW EXECUTE FUNCTION aec_assert_procurement_references_owned();
CREATE TRIGGER trg_aec_rfq_suppliers_references
    BEFORE INSERT OR UPDATE ON aec_rfq_suppliers
    FOR EACH ROW EXECUTE FUNCTION aec_assert_procurement_references_owned();
CREATE TRIGGER trg_aec_supplier_quotations_references
    BEFORE INSERT OR UPDATE ON aec_supplier_quotations
    FOR EACH ROW EXECUTE FUNCTION aec_assert_procurement_references_owned();
CREATE TRIGGER trg_aec_commitments_references
    BEFORE INSERT OR UPDATE ON aec_commitments
    FOR EACH ROW EXECUTE FUNCTION aec_assert_procurement_references_owned();
CREATE TRIGGER trg_aec_commitment_deliveries_references
    BEFORE INSERT OR UPDATE ON aec_commitment_deliveries
    FOR EACH ROW EXECUTE FUNCTION aec_assert_procurement_references_owned();
CREATE TRIGGER trg_aec_procurement_events_references
    BEFORE INSERT OR UPDATE ON aec_procurement_events
    FOR EACH ROW EXECUTE FUNCTION aec_assert_procurement_references_owned();

-- ---------------------------------------------------------------------------
-- 9. §18's immutability — what was asked for and what was quoted
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION aec_material_request_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'aec_material_requests: only a draft request can be deleted'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- What the approver and the suppliers saw cannot change underneath them:
        -- the title, the scope, the package, the date it is needed by and the
        -- lines (their own guard). The status chain and the three dates move.
        IF OLD.status NOT IN ('draft', 'rejected') THEN
            IF NEW.title IS DISTINCT FROM OLD.title
               OR NEW.description IS DISTINCT FROM OLD.description
               OR NEW.work_package IS DISTINCT FROM OLD.work_package
               OR NEW.priority IS DISTINCT FROM OLD.priority
               OR NEW.required_by IS DISTINCT FROM OLD.required_by
               OR NEW.project_id IS DISTINCT FROM OLD.project_id
               OR NEW.request_number IS DISTINCT FROM OLD.request_number
               OR NEW.created_by IS DISTINCT FROM OLD.created_by
            THEN
                RAISE EXCEPTION 'aec_material_requests: a submitted request is frozen; reject it to revise it'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION aec_material_request_line_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    parent_status text;
BEGIN
    SELECT status INTO parent_status FROM aec_material_requests
     WHERE id = COALESCE(NEW.request_id, OLD.request_id);
    IF parent_status IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF parent_status NOT IN ('draft', 'rejected') THEN
        RAISE EXCEPTION 'aec_material_request_lines: a submitted request cannot be re-scoped'
            USING ERRCODE = '23514';
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION aec_rfq_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'aec_rfqs: only a draft RFQ can be deleted' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
        IF NEW.title IS DISTINCT FROM OLD.title
           OR NEW.scope IS DISTINCT FROM OLD.scope
           OR NEW.request_id IS DISTINCT FROM OLD.request_id
           OR NEW.due_date IS DISTINCT FROM OLD.due_date
           OR NEW.response_due IS DISTINCT FROM OLD.response_due
           OR NEW.project_id IS DISTINCT FROM OLD.project_id
           OR NEW.rfq_number IS DISTINCT FROM OLD.rfq_number
        THEN
            RAISE EXCEPTION 'aec_rfqs: an issued RFQ is frozen; the suppliers are quoting it'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION aec_quotation_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    rfq_status text;
BEGIN
    SELECT status INTO rfq_status FROM aec_rfqs
     WHERE id = COALESCE(NEW.rfq_id, OLD.rfq_id);
    IF TG_OP = 'INSERT' AND rfq_status IN ('closed', 'cancelled') THEN
        RAISE EXCEPTION 'aec_supplier_quotations: the RFQ is closed'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status IN ('selected', 'declined') THEN
        RAISE EXCEPTION 'aec_supplier_quotations: a decided quotation is history'
            USING ERRCODE = '23514';
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION aec_commitment_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'aec_commitments: only a draft commitment can be deleted'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- The award the approver agreed, and the suppliers' reference to it, are
        -- frozen from submission: the status chain and the three dates move, the
        -- content does not.
        IF OLD.status NOT IN ('draft', 'rejected') THEN
            IF NEW.kind IS DISTINCT FROM OLD.kind
               OR NEW.commitment_number IS DISTINCT FROM OLD.commitment_number
               OR NEW.supplier_party_id IS DISTINCT FROM OLD.supplier_party_id
               OR NEW.title IS DISTINCT FROM OLD.title
               OR NEW.scope IS DISTINCT FROM OLD.scope
               OR NEW.work_package IS DISTINCT FROM OLD.work_package
               OR NEW.value_rial IS DISTINCT FROM OLD.value_rial
               OR NEW.expected_delivery_date IS DISTINCT FROM OLD.expected_delivery_date
               OR NEW.request_id IS DISTINCT FROM OLD.request_id
               OR NEW.rfq_id IS DISTINCT FROM OLD.rfq_id
               OR NEW.quotation_id IS DISTINCT FROM OLD.quotation_id
               OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
               OR NEW.project_id IS DISTINCT FROM OLD.project_id
               OR NEW.created_by IS DISTINCT FROM OLD.created_by
            THEN
                RAISE EXCEPTION 'aec_commitments: a submitted commitment is frozen; reopen it to change it'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF OLD.status = 'delivered' THEN
            -- A delivered award has one move left: closing it out, which is when
            -- the invoice and the payment become Accounting's business. Accepting
            -- that transition is what keeps §18's chain walkable to its end; every
            -- other change to a delivered award is refused.
            IF NEW.status <> 'closed'
               OR NEW.kind IS DISTINCT FROM OLD.kind
               OR NEW.commitment_number IS DISTINCT FROM OLD.commitment_number
               OR NEW.supplier_party_id IS DISTINCT FROM OLD.supplier_party_id
               OR NEW.title IS DISTINCT FROM OLD.title
               OR NEW.scope IS DISTINCT FROM OLD.scope
               OR NEW.work_package IS DISTINCT FROM OLD.work_package
               OR NEW.value_rial IS DISTINCT FROM OLD.value_rial
               OR NEW.expected_delivery_date IS DISTINCT FROM OLD.expected_delivery_date
               OR NEW.request_id IS DISTINCT FROM OLD.request_id
               OR NEW.rfq_id IS DISTINCT FROM OLD.rfq_id
               OR NEW.quotation_id IS DISTINCT FROM OLD.quotation_id
               OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
               OR NEW.project_id IS DISTINCT FROM OLD.project_id
               OR NEW.created_by IS DISTINCT FROM OLD.created_by
            THEN
                RAISE EXCEPTION 'aec_commitments: a delivered commitment can only be closed'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF OLD.status IN ('closed', 'cancelled') THEN
            RAISE EXCEPTION 'aec_commitments: a closed or cancelled commitment cannot change'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION aec_commitment_delivery_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    parent_status text;
BEGIN
    SELECT status INTO parent_status FROM aec_commitments
     WHERE id = COALESCE(NEW.commitment_id, OLD.commitment_id);
    IF TG_OP = 'INSERT' AND parent_status NOT IN ('approved', 'delivered') THEN
        RAISE EXCEPTION 'aec_commitment_deliveries: only an approved commitment takes a delivery'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') AND parent_status NOT IN ('approved', 'delivered') THEN
        RAISE EXCEPTION 'aec_commitment_deliveries: a closed or cancelled commitment''s deliveries are history'
            USING ERRCODE = '23514';
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_aec_material_requests_guard
    BEFORE UPDATE OR DELETE ON aec_material_requests
    FOR EACH ROW EXECUTE FUNCTION aec_material_request_guard();
CREATE TRIGGER trg_aec_material_request_lines_guard
    BEFORE INSERT OR UPDATE OR DELETE ON aec_material_request_lines
    FOR EACH ROW EXECUTE FUNCTION aec_material_request_line_guard();
CREATE TRIGGER trg_aec_rfqs_guard
    BEFORE UPDATE OR DELETE ON aec_rfqs
    FOR EACH ROW EXECUTE FUNCTION aec_rfq_guard();
CREATE TRIGGER trg_aec_supplier_quotations_guard
    BEFORE INSERT OR UPDATE ON aec_supplier_quotations
    FOR EACH ROW EXECUTE FUNCTION aec_quotation_guard();
CREATE TRIGGER trg_aec_commitments_guard
    BEFORE UPDATE OR DELETE ON aec_commitments
    FOR EACH ROW EXECUTE FUNCTION aec_commitment_guard();
CREATE TRIGGER trg_aec_commitment_deliveries_guard
    BEFORE INSERT OR UPDATE OR DELETE ON aec_commitment_deliveries
    FOR EACH ROW EXECUTE FUNCTION aec_commitment_delivery_guard();

-- ---------------------------------------------------------------------------
-- 10. Approvals and the activity feed carry the two new subjects (§18's
--     "approval", §33's "procurement approval")
-- ---------------------------------------------------------------------------
-- A submitted material request and a submitted commitment each file one
-- `workspace_approvals` row, exactly as a variation, a claim, a BOQ revision and
-- a submittal do — one approval engine, §24's rule, so "procurement manage"
-- stays a register edit and the award is decided on `workspace.approve`.
ALTER TABLE workspace_approvals DROP CONSTRAINT IF EXISTS workspace_approvals_subject_type_check;
ALTER TABLE workspace_approvals ADD CONSTRAINT workspace_approvals_subject_type_check
    CHECK (subject_type IN (
        'project', 'task', 'document', 'contract', 'estimate_version',
        'submittal_revision', 'variation', 'payment_certificate',
        'material_request', 'commitment'
    ));

ALTER TABLE workspace_activity DROP CONSTRAINT IF EXISTS workspace_activity_subject_type_check;
ALTER TABLE workspace_activity ADD CONSTRAINT workspace_activity_subject_type_check
    CHECK (subject_type IN (
        'project', 'task', 'document', 'contract', 'approval', 'member', 'event',
        'estimate', 'document_revision', 'transmittal', 'rfi', 'submittal',
        'site_log', 'site_issue', 'variation', 'payment_certificate',
        'material_request', 'rfq', 'commitment'
    ));

-- ---------------------------------------------------------------------------
-- 11. §22's widget
-- ---------------------------------------------------------------------------
-- §22 names "Procurement Delays" among the recommended industry widgets, and
-- this wave is the one that has the data for it: approved commitments whose
-- expected delivery date has passed. The other §22 entries this wave touches
-- (committed vs budget, project margin) ride the project's own commercial
-- cockpit, where the basis of the forecast is stated next to the figure — a
-- widget is read without that context, which is why the margin widget is still
-- deliberately not seeded.
INSERT INTO ai_widget_templates
  (name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height, created_by)
SELECT v.name, v.description, v.industry, v.source_app, v.required_permissions, v.prompt, v.output_format, v.default_width, v.default_height, 'system'
  FROM (VALUES
    (
      'تأخیر تأمین',
      'تعهدات خرید و پیمان‌های جزئی که از موعد تحویل گذشته‌اند، به‌ترتیب بدترین تأخیر',
      'architecture_construction',
      'workspace',
      ARRAY['workspace.view']::text[],
      'تعهدات تأمین عقب‌افتاده را بنویس: پروژه، تأمین‌کننده، موضوع، مبلغ، تاریخ تحویل مورد انتظار و چند روز تأخیر. سپس بگو کدام تأخیرها برنامهٔ پروژه را تهدید می‌کنند.',
      'bullets',
      2,
      1
    )
  ) AS v(name, description, industry, source_app, required_permissions, prompt, output_format, default_width, default_height)
 WHERE NOT EXISTS (
   SELECT 1 FROM ai_widget_templates t
    WHERE t.industry = v.industry AND t.name = v.name
 );
