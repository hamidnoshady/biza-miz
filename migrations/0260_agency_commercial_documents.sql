-- ============================================================================
-- 0260_agency_commercial_documents.sql — issue #1128 §D: the billing documents
-- of an advertising agency.
--
-- §D asks for "service/project estimates and invoices, milestones/deposits,
-- fixed-price engagements, retainers/subscriptions, hourly/time-and-material
-- work, change requests, client receivables and overdue balances", and for a
-- campaign/project P&L that keeps booked figures apart from posted ones.
--
-- Two registers carry it, in the order an agency's money actually moves:
--
--   1. `agency_billing_milestones` — what a client agreed to pay, when, and
--                                     which of it has been invoiced. Numbered
--                                     `MS-001` per project.
--   2. `agency_change_requests`    — what changed the engagement after it was
--                                     agreed, and what the client approved.
--                                     Numbered `CR-001` per project.
--
-- WHY THERE IS NO THIRD TABLE. §D also names fixed-price engagements,
-- retainers and hourly work, and it is tempting to give each a register. They
-- are shapes of the *same* agreement, not separate documents: the engagement's
-- value and dates live on `workspace_contracts` (§17's block, shipped for every
-- industry), the shape is vocabulary in `src/lib/agency-commercial.ts`
-- (`AGENCY_BILLING_BASES`), and what a shape produces is rows in register 1 —
-- a deposit and a final settlement for a fixed price, one row per period for a
-- retainer, one row per invoiced period for hourly work. A separate "billing
-- plan" table would hold a second copy of the same percentages, and two copies
-- of a schedule is a schedule that can disagree with itself.
--
-- SEVEN RULES THIS FILE EXISTS TO ENFORCE, in the database rather than only in
-- the service:
--
--   * A MILESTONE IS A PERCENTAGE *OR* AN AMOUNT — never both, never neither.
--     Both is two answers to "how much"; neither is nothing to bill. The
--     percentage is deliberately not resolved to an amount here: it is a share
--     of the engagement's *revised* value, which moves when a change request is
--     approved, and freezing it would make the schedule lie the first time the
--     scope did.
--   * NOTHING HERE REWRITES THE SIGNED VALUE. An approved change request moves
--     a revised figure that the service computes from `value_rial` plus the
--     approved requests; `workspace_contracts.value_rial` stays what the client
--     signed. (The AEC registers keep a stored revised value because their
--     certificates must not be recomputed after the fact; an agency's schedule
--     is small enough to be read, and a stored second value is a second fact to
--     keep in step.)
--   * THE REVENUE ACCOUNT MUST EXIST IN THIS TENANT'S OWN CHART. The four codes
--     are the trade's own (`service-invoice.ts`: 4640 campaign management,
--     4650 creative and production, 4660 media, 4670 events and PR) and the
--     invoice layer refuses anything else — so a milestone crediting a code the
--     tenant does not have would offer an account its own invoice cannot use.
--   * AN INVOICE IS A REAL INVOICE OF THE SAME TENANT. `orders` is scoped by
--     location rather than by business, so this is a trigger through
--     `locations.business_id`, exactly as 0200 §7 does for the references that
--     cannot use a composite key.
--   * A SUBMITTED ROW IS FROZEN, AND AN INVOICED ONE IS HISTORY. What a client
--     was sent cannot change underneath them, and a milestone that has produced
--     an invoice is the record of money that exists in the ledger.
--   * APPROVALS RIDE THE ONE ENGINE. A submitted milestone and a submitted
--     change request each file one `workspace_approvals` row, exactly as a
--     variation, a certificate, a material request and a commitment do — §24's
--     rule that a commercial action must not inherit ordinary task-edit rights.
--     Two subject types are added to the existing CHECKs; no approval table of
--     our own.
--   * NOTHING HERE POSTS A JOURNAL ENTRY. Revenue is posted by the invoice the
--     milestone points at (`service.sale_revenue`), tax and discount belong to
--     that document and not to this row, and the cost side of §D's P&L is read
--     from `journal_entries.project_id` — which is why this file has no cost
--     column at all. A stored cost would be a second, staler answer to a
--     question the ledger already answers.
--
-- Additive and idempotent: two new tables, two new subject types on two
-- existing CHECKs. No backfill — no existing tenant has an agency billing
-- schedule to migrate.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The billing schedule
-- ---------------------------------------------------------------------------
CREATE TABLE agency_billing_milestones (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id        uuid NOT NULL,
    -- Optional, exactly as a variation's contract is: a schedule is laid out
    -- before the engagement it bills is signed more often than not (an agency
    -- prices a campaign, then signs it). It is the percentage that then has no
    -- value to be taken against — never the row that is lost.
    contract_id       uuid REFERENCES workspace_contracts(id) ON DELETE SET NULL,
    milestone_number  text NOT NULL CHECK (btrim(milestone_number) <> ''),
    -- §D's four shapes land here as four kinds rather than as four tables: a
    -- deposit and a final settlement on a fixed price, delivery stages on a
    -- milestone engagement, one row per period on a retainer, one row per
    -- invoiced period on hourly work.
    kind              text NOT NULL DEFAULT 'deliverable'
                          CHECK (kind IN ('deposit', 'deliverable', 'retainer_period', 'final')),
    title             text NOT NULL CHECK (btrim(title) <> ''),
    description       text NOT NULL DEFAULT '',
    -- A percentage of the engagement's revised value, or a fixed Rial amount.
    -- Exactly one; the CHECK below is the rule, and `numeric(5,2)` is what
    -- makes a three-way split of 100% expressible as 33.33/33.33/33.34 rather
    -- than as three integers that cannot sum to the whole.
    percent           numeric(5,2) CHECK (percent IS NULL OR (percent > 0 AND percent <= 100)),
    amount_rial       bigint CHECK (amount_rial IS NULL OR amount_rial > 0),
    -- The account this line will credit when it is invoiced. A column rather
    -- than a lookup so the schedule says which of the trade's four revenue
    -- accounts a media recharge belongs to — §D asks for media spend to be
    -- separable from agency service fees, and on the revenue side that
    -- separation is this code.
    revenue_code      text NOT NULL DEFAULT '4640'
                          CHECK (revenue_code IN ('4640', '4650', '4660', '4670')),
    -- Hours behind an amount, for time-and-material work. It records what the
    -- figure covers and is never a second amount: the CHECK below refuses hours
    -- on a percentage, because a percentage of a contract has no hours in it.
    hours             numeric(10,2) CHECK (hours IS NULL OR hours > 0),
    due_date          date,
    -- A retainer period's own two dates. §D's "overdue balances" is measured
    -- from `due_date`; these are what a client disputes first about a retainer
    -- invoice, so they are columns rather than a note.
    period_start_date date,
    period_end_date   date,
    status            text NOT NULL DEFAULT 'draft'
                          CHECK (status IN (
                              'draft', 'submitted', 'approved', 'invoiced', 'rejected', 'cancelled'
                          )),
    submitted_date    date,
    approved_date     date,
    invoiced_date     date,
    -- The invoice this milestone produced. `RESTRICT` rather than `SET NULL`:
    -- nulling it would break the `invoiced` CHECK below at the moment somebody
    -- deleted an invoice, turning "this was billed" into a row that cannot
    -- exist. An invoice a schedule has recorded is not deletable; voiding it is
    -- the invoice layer's own act.
    invoice_order_id  uuid REFERENCES orders(id) ON DELETE RESTRICT,
    created_by        uuid,
    created_by_name   text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    -- The rule that carries this register: one answer to "how much".
    CHECK ((percent IS NULL) <> (amount_rial IS NULL)),
    CHECK (milestone_number LIKE 'MS-%'),
    CHECK (hours IS NULL OR amount_rial IS NOT NULL),
    CHECK (period_start_date IS NULL OR period_end_date IS NULL
           OR period_end_date >= period_start_date),
    -- A period without dates is a retainer line nobody can place in a calendar,
    -- which is the whole point of a retainer invoice.
    CHECK (kind <> 'retainer_period' OR status NOT IN ('submitted', 'approved', 'invoiced')
           OR (period_start_date IS NOT NULL AND period_end_date IS NOT NULL)),
    -- A row an approver reads names its two dates: when it was sent, and when
    -- the client is expected to pay. The second is what §D's overdue balances
    -- are measured from, so an approved milestone without one could never be
    -- reported as late.
    CHECK (status NOT IN ('submitted', 'approved', 'invoiced', 'rejected')
           OR (submitted_date IS NOT NULL AND due_date IS NOT NULL)),
    CHECK (status NOT IN ('approved', 'invoiced') OR approved_date IS NOT NULL),
    CHECK (status <> 'invoiced' OR (invoiced_date IS NOT NULL AND invoice_order_id IS NOT NULL)),
    -- One number per project, however many people lay a schedule out.
    UNIQUE (business_id, project_id, milestone_number),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_agency_billing_milestones_project
    ON agency_billing_milestones (business_id, project_id, status);
CREATE INDEX idx_agency_billing_milestones_contract
    ON agency_billing_milestones (contract_id) WHERE contract_id IS NOT NULL;
CREATE INDEX idx_agency_billing_milestones_invoice
    ON agency_billing_milestones (invoice_order_id) WHERE invoice_order_id IS NOT NULL;
-- "What is approved and not yet billed, oldest first?" — the one read the
-- billing queue, the overdue report and the cockpit's unbilled figure share.
-- Partial because the four statuses it excludes cannot be waiting to be billed.
CREATE INDEX idx_agency_billing_milestones_billable
    ON agency_billing_milestones (business_id, due_date)
 WHERE status = 'approved';

-- ---------------------------------------------------------------------------
-- 2. The change requests
-- ---------------------------------------------------------------------------
CREATE TABLE agency_change_requests (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id            uuid NOT NULL,
    contract_id           uuid REFERENCES workspace_contracts(id) ON DELETE SET NULL,
    change_request_number text NOT NULL CHECK (btrim(change_request_number) <> ''),
    title                 text NOT NULL CHECK (btrim(title) <> ''),
    -- Two facts, not one: what changes in the deliverables, and why. A request
    -- sent to a client with only one of them is a request for money with no
    -- explanation, which is how agencies lose the argument.
    description           text NOT NULL DEFAULT '',
    reason                text NOT NULL DEFAULT '',
    -- Signed, and never zero. A descope is a negative figure rather than a
    -- second column, so the register cannot hold two amounts that have to agree
    -- with each other — and so the revised value is one addition, not a
    -- subtraction somebody has to remember.
    amount_rial           bigint CHECK (amount_rial IS NULL OR amount_rial <> 0),
    -- What the client agreed to, which may be less than what was asked. That
    -- difference is the commercial story of a change request, so both are kept.
    approved_amount_rial  bigint CHECK (approved_amount_rial IS NULL OR approved_amount_rial <> 0),
    -- Days added to the schedule. Negative is deliberate, exactly as it is on a
    -- variation: a descope or a dropped deliverable shortens it, and refusing
    -- to record that would push it into a note.
    schedule_impact_days  integer,
    status                text NOT NULL DEFAULT 'draft'
                              CHECK (status IN (
                                  'draft', 'priced', 'submitted', 'approved',
                                  'rejected', 'implemented', 'withdrawn'
                              )),
    submitted_date        date,
    approved_date         date,
    implemented_date      date,
    created_by            uuid,
    created_by_name       text NOT NULL DEFAULT '',
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CHECK (change_request_number LIKE 'CR-%'),
    -- A "priced" request with no price would be a screen that lies, and a
    -- submitted one with no stated schedule effect is a change nobody can plan
    -- around. Both are the chain's own preconditions, as data rules.
    CHECK (status NOT IN ('priced', 'submitted', 'approved', 'rejected', 'implemented')
           OR amount_rial IS NOT NULL),
    CHECK (status NOT IN ('submitted', 'approved', 'rejected', 'implemented')
           OR (btrim(description) <> '' AND schedule_impact_days IS NOT NULL)),
    CHECK (status NOT IN ('approved', 'implemented')
           OR (approved_amount_rial IS NOT NULL AND approved_date IS NOT NULL)),
    CHECK (status <> 'implemented' OR implemented_date IS NOT NULL),
    UNIQUE (business_id, project_id, change_request_number),
    FOREIGN KEY (business_id, project_id)
        REFERENCES ai_projects (business_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_agency_change_requests_project
    ON agency_change_requests (business_id, project_id, status);
CREATE INDEX idx_agency_change_requests_contract
    ON agency_change_requests (contract_id) WHERE contract_id IS NOT NULL;
-- "Which changes are waiting on the client?" — the same read the project page
-- and the cockpit's committed-value figure need.
CREATE INDEX idx_agency_change_requests_open
    ON agency_change_requests (business_id, project_id)
 WHERE status IN ('priced', 'submitted');

-- ---------------------------------------------------------------------------
-- 3. The references that cannot use a composite key
-- ---------------------------------------------------------------------------
-- A nullable contract, a user pointer and — on the milestone — an invoice.
-- `MATCH SIMPLE` would skip the check whenever the column is null, and a
-- composite key with `ON DELETE SET NULL` would null `business_id` with it, so
-- these are triggers: 0200 §7's shape, for the same reason.
--
-- The invoice needs one step more than the others. `orders` carries no
-- `business_id` at all — it is scoped by location (RLS shape 2) — so ownership
-- is read through `locations.business_id`. Note what is *not* checked here: the
-- invoice's kind. `order_type` has no `service` member (a service invoice is an
-- `orders` row of type `retail` whose only line kind is `service`), so asserting
-- a kind would assert something this schema cannot say. That the invoice's lines
-- are services is the invoice layer's own rule, in
-- `LINE_KINDS_BY_INDUSTRY`.
CREATE OR REPLACE FUNCTION agency_assert_milestone_references_owned() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
BEGIN
    IF NEW.contract_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM workspace_contracts WHERE id = NEW.contract_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'agency_billing_milestones: contract does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'agency_billing_milestones: contract belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.invoice_order_id IS NOT NULL THEN
        SELECT l.business_id INTO owner_business
          FROM orders o
          JOIN locations l ON l.id = o.location_id
         WHERE o.id = NEW.invoice_order_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'agency_billing_milestones: invoice does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'agency_billing_milestones: invoice belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.created_by IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM users WHERE id = NEW.created_by;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'agency_billing_milestones: creator belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_agency_billing_milestones_references
    BEFORE INSERT OR UPDATE ON agency_billing_milestones
    FOR EACH ROW EXECUTE FUNCTION agency_assert_milestone_references_owned();

CREATE OR REPLACE FUNCTION agency_assert_change_request_references_owned() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
BEGIN
    IF NEW.contract_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM workspace_contracts WHERE id = NEW.contract_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'agency_change_requests: contract does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'agency_change_requests: contract belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.created_by IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM users WHERE id = NEW.created_by;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'agency_change_requests: creator belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_agency_change_requests_references
    BEFORE INSERT OR UPDATE ON agency_change_requests
    FOR EACH ROW EXECUTE FUNCTION agency_assert_change_request_references_owned();

-- ---------------------------------------------------------------------------
-- 4. The revenue account must be this tenant's own
-- ---------------------------------------------------------------------------
-- Checked on insert and whenever the code changes, and not on every update: a
-- milestone approved after its account was deactivated should still be
-- approvable, and whether an inactive account can be posted to is the invoice
-- layer's decision, not this row's. Existence in the chart is the invariant —
-- `UNIQUE (business_id, code)` makes the lookup an index probe.
CREATE OR REPLACE FUNCTION agency_assert_milestone_revenue_account() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.revenue_code IS DISTINCT FROM OLD.revenue_code
       OR NEW.business_id IS DISTINCT FROM OLD.business_id THEN
        IF NOT EXISTS (
            SELECT 1 FROM accounts a
             WHERE a.business_id = NEW.business_id AND a.code = NEW.revenue_code
        ) THEN
            RAISE EXCEPTION 'agency_billing_milestones: revenue account % is not in this business''s chart of accounts',
                NEW.revenue_code
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_agency_billing_milestones_revenue_account
    BEFORE INSERT OR UPDATE ON agency_billing_milestones
    FOR EACH ROW EXECUTE FUNCTION agency_assert_milestone_revenue_account();

-- ---------------------------------------------------------------------------
-- 5. §D's immutability: what a client was sent, and what was billed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agency_billing_milestone_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'agency_billing_milestones: only a draft milestone can be deleted'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- What an approver is reading cannot change underneath them. The status
        -- chain and its own dates still move — including the invoice pointer,
        -- which is the one write that happens *after* approval.
        IF OLD.status NOT IN ('draft', 'rejected') THEN
            IF NEW.title IS DISTINCT FROM OLD.title
               OR NEW.description IS DISTINCT FROM OLD.description
               OR NEW.kind IS DISTINCT FROM OLD.kind
               OR NEW.percent IS DISTINCT FROM OLD.percent
               OR NEW.amount_rial IS DISTINCT FROM OLD.amount_rial
               OR NEW.hours IS DISTINCT FROM OLD.hours
               OR NEW.revenue_code IS DISTINCT FROM OLD.revenue_code
               OR NEW.due_date IS DISTINCT FROM OLD.due_date
               OR NEW.period_start_date IS DISTINCT FROM OLD.period_start_date
               OR NEW.period_end_date IS DISTINCT FROM OLD.period_end_date
               OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
               OR NEW.milestone_number IS DISTINCT FROM OLD.milestone_number
               OR NEW.project_id IS DISTINCT FROM OLD.project_id
               OR NEW.created_by IS DISTINCT FROM OLD.created_by
            THEN
                RAISE EXCEPTION 'agency_billing_milestones: a submitted milestone is frozen; reopen it to change it'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        -- An invoiced milestone is the record of money that exists in the
        -- ledger, and `invoiced` is the end of the chain: `canTransitionMilestone`
        -- gives it no successor, so the database must not permit one either.
        -- Undoing a bill is a credit note in Accounting, not a status change
        -- here — a register that could quietly un-bill itself would leave the
        -- invoice, the ledger and this row telling three different stories.
        IF OLD.status = 'invoiced' THEN
            RAISE EXCEPTION 'agency_billing_milestones: an invoiced milestone is a record and cannot change'
                USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'cancelled' THEN
            RAISE EXCEPTION 'agency_billing_milestones: a cancelled milestone cannot change'
                USING ERRCODE = '23514';
        END IF;
        -- Taking a rejected milestone back to draft is a status move, not a
        -- content edit, so it passes the freeze above untouched: the *next*
        -- write is the one the freeze then lets through, because the row is
        -- `draft` by then.
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_agency_billing_milestones_guard
    BEFORE UPDATE OR DELETE ON agency_billing_milestones
    FOR EACH ROW EXECUTE FUNCTION agency_billing_milestone_guard();

CREATE OR REPLACE FUNCTION agency_change_request_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'agency_change_requests: only a draft change request can be deleted'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.status NOT IN ('draft', 'priced', 'rejected') THEN
            IF NEW.title IS DISTINCT FROM OLD.title
               OR NEW.description IS DISTINCT FROM OLD.description
               OR NEW.reason IS DISTINCT FROM OLD.reason
               OR NEW.amount_rial IS DISTINCT FROM OLD.amount_rial
               OR NEW.schedule_impact_days IS DISTINCT FROM OLD.schedule_impact_days
               OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
               OR NEW.change_request_number IS DISTINCT FROM OLD.change_request_number
               OR NEW.project_id IS DISTINCT FROM OLD.project_id
               OR NEW.created_by IS DISTINCT FROM OLD.created_by
            THEN
                RAISE EXCEPTION 'agency_change_requests: a submitted change request is frozen; reopen it to re-price it'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        IF OLD.status = 'implemented' THEN
            RAISE EXCEPTION 'agency_change_requests: an implemented change request is a record and cannot change'
                USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'withdrawn' THEN
            RAISE EXCEPTION 'agency_change_requests: a withdrawn change request cannot change'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_agency_change_requests_guard
    BEFORE UPDATE OR DELETE ON agency_change_requests
    FOR EACH ROW EXECUTE FUNCTION agency_change_request_guard();

-- ---------------------------------------------------------------------------
-- 6. Tenant isolation
-- ---------------------------------------------------------------------------
-- Both registers carry `business_id` directly, so they are RLS shape 1: the
-- standard `tenant_isolation` policy, fail-closed when `app.business_id` is
-- unset. Without this, isolation would be a property of every route handler
-- that reads a schedule rather than a property of the database.
ALTER TABLE agency_billing_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_billing_milestones FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agency_billing_milestones;
CREATE POLICY tenant_isolation ON agency_billing_milestones FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE agency_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_change_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agency_change_requests;
CREATE POLICY tenant_isolation ON agency_change_requests FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 7. Approvals and the activity feed carry the two new subjects
-- ---------------------------------------------------------------------------
-- §D's determinations are the shared engine's, under `workspace.approve`:
-- submitting a milestone, approving or rejecting it, invoicing it, cancelling
-- it, and the same four acts on a change request. Writing a schedule stays
-- `workspace.manage`. That split is stated once in `agency-commercial.ts`
-- (`AGENCY_MILESTONE_ACTIONS` / `AGENCY_CHANGE_REQUEST_ACTIONS`, with
-- `determination` on each) so six route handlers cannot each invent their own.
--
-- Widening both CHECKs is additive and idempotent: each new list is a superset
-- of 0201's, so a schema where the constraint is named differently keeps both
-- and neither refuses an existing row.
ALTER TABLE workspace_approvals DROP CONSTRAINT IF EXISTS workspace_approvals_subject_type_check;
ALTER TABLE workspace_approvals ADD CONSTRAINT workspace_approvals_subject_type_check
    CHECK (subject_type IN (
        'project', 'task', 'document', 'contract', 'estimate_version',
        'submittal_revision', 'variation', 'payment_certificate',
        'material_request', 'commitment',
        'billing_milestone', 'change_request'
    ));

ALTER TABLE workspace_activity DROP CONSTRAINT IF EXISTS workspace_activity_subject_type_check;
ALTER TABLE workspace_activity ADD CONSTRAINT workspace_activity_subject_type_check
    CHECK (subject_type IN (
        'project', 'task', 'document', 'contract', 'approval', 'member', 'event',
        'estimate', 'document_revision', 'transmittal', 'rfi', 'submittal',
        'site_log', 'site_issue', 'variation', 'payment_certificate',
        'material_request', 'rfq', 'commitment',
        'billing_milestone', 'change_request'
    ));
