-- ============================================================================
-- 0276_agency_proposals.sql — issue #1128 §A + §D: the offer, priced
--
-- §A asks for "proposals/quotes" in the CRM and §D asks for "service/project
-- estimates" in the billing set. Those are one document, and §B's stage list is
-- what settles it: "brief → discovery → **proposal/quote** → contract → kickoff".
-- One name, one position, one lifecycle. Two tables would be the same offer in
-- two places, free to disagree about the price — and a price two systems disagree
-- about is the one disagreement a client always notices.
--
-- WHERE IT SITS. A brief (0274) records what the client asked for; a proposal
-- records what the agency offers in answer, at what price, valid until when; a
-- contract (`workspace_contracts`, 0167) records what was signed. So a proposal
-- carries three pointers, and each is written at a different moment:
--
--   * `brief_id` — the requirement it prices, usually present from the start;
--   * `deal_id` / `project_id` — where the work lives, exactly as on a brief;
--   * `contract_id` — what it became, written *after* acceptance.
--
-- THE HEADER STORES NO TOTAL. `discount_rial` and `tax_rial` live on the header
-- because they are policy inputs; the subtotal is the sum of the lines and the
-- total is derived from both. A stored total is a second answer to "how much",
-- and the only way to keep two answers agreeing is a trigger whose whole job is
-- bookkeeping — so there is one answer instead. Every line's own `amount_rial`
-- *is* stored, and is computed by a trigger from quantity × unit price rather
-- than trusted from the caller: a line whose amount disagrees with its own
-- quantity and price is a bug nobody can see, because both readings look correct.
--
-- `cost_rial` AND `pass_through` ARE INTERNAL. `cost_rial` is what the agency
-- pays for the line, so the margin on an offer is visible *before* it is sent —
-- an agency that cannot see its own margin on a media buy is guessing. Neither
-- field may ever reach a client-facing screen; the route that serves the client
-- copy is a different door, and this file's comment is the only thing standing
-- between them, which is why it is written twice.
--
-- `pass_through` is where §D's gross-vs-net question gets *answered*, though not
-- where it gets posted: a media recharge is the agency's own money moving through
-- its accounts or the client's money moving past them, and that is a decision
-- made line by line at offer time, not discovered at invoice time. Nothing here
-- reaches account 1270 and nothing here posts — §D's invoice layer reads this
-- flag when it is built.
--
-- FROZEN FROM `sent`, NOT FROM ACCEPTANCE. A brief freezes at `confirmed` because
-- only then has the client agreed to something. A proposal freezes earlier, when
-- it is sent, because it states a *price*: a client reading «۵۰۰٬۰۰۰٬۰۰۰ ریال»
-- must not find «۶۵۰٬۰۰۰٬۰۰۰ ریال» when they come back. That is 0260's rule for
-- a submitted milestone ("what an approver is reading cannot change underneath
-- them") applied to the document an approver reads first. The correction is a new
-- proposal — a second number in the series, which is also the audit trail.
--
-- `contract_id` is deliberately NOT frozen, for the reason 0260 gives for its
-- `invoice_order_id` and 0274 for its `project_id`: it is the one write that
-- happens *after* the determination, and freezing it would make the outcome
-- unrecordable.
--
-- NOTHING HERE POSTS A JOURNAL ENTRY. An accepted proposal is not a receivable —
-- it is an agreement that money will become due, and §D's registers own the
-- moment it does.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The proposal
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agency_proposals (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    proposal_number   text NOT NULL CHECK (btrim(proposal_number) <> ''),

    -- The client being offered to. NOT NULL for the reason a brief's is: a
    -- proposal with no client is a price list, and this product already has those.
    party_id          uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    -- The requirement this prices. `SET NULL` rather than `CASCADE`: a brief is a
    -- record of what was asked, and withdrawing it should not destroy the offer
    -- that answered it. A *simple* FK, not the composite one 0274 made possible:
    -- Postgres refuses `ON DELETE SET NULL` on a composite key whose other column
    -- is `NOT NULL`, and `business_id` here is. So tenant ownership of the brief
    -- is the trigger's job below, alongside the sharper question of whether the
    -- brief was even written for this client.
    brief_id          uuid REFERENCES agency_client_briefs(id) ON DELETE SET NULL,
    deal_id           uuid REFERENCES crm_deals(id) ON DELETE SET NULL,
    project_id        uuid REFERENCES ai_projects(id) ON DELETE SET NULL,
    -- What the offer became. Written after acceptance, so not frozen.
    contract_id       uuid REFERENCES workspace_contracts(id) ON DELETE SET NULL,

    title             text NOT NULL CHECK (btrim(title) <> ''),
    status            text NOT NULL DEFAULT 'draft'
                          CHECK (status IN (
                              'draft', 'sent', 'accepted', 'declined', 'expired', 'withdrawn'
                          )),

    -- §A's "scope of work": what is included, in prose. The lines say what is
    -- priced; this says what that means. Both, because a client disputes the
    -- prose and an accountant reads the lines.
    scope_of_work     text NOT NULL DEFAULT '',
    terms             text NOT NULL DEFAULT '',

    -- Policy inputs, not derived figures. Zero is the honest default: an offer
    -- with no discount and no tax is the common case, and NULL would make every
    -- reader decide what an absent discount means.
    discount_rial     bigint NOT NULL DEFAULT 0 CHECK (discount_rial >= 0),
    tax_rial          bigint NOT NULL DEFAULT 0 CHECK (tax_rial >= 0),

    -- A quote is an offer with a clock on it. Nullable, because "open until we
    -- say otherwise" is a real thing an agency offers a long-standing client —
    -- but then `expired` is not a status this row can reach, and the CHECK below
    -- says so.
    valid_until       date,

    -- §A's stakeholder, again: the person on the client's side who may accept.
    -- The trigger requires them to be a contact of *this* proposal's own client,
    -- so one client's decision-maker cannot accept another client's offer.
    client_contact_party_id uuid REFERENCES parties(id) ON DELETE SET NULL,
    client_contact_name text NOT NULL DEFAULT '',

    sent_at           timestamptz,
    decided_at        timestamptz,
    -- Who decided, as a name. The client has no user row and must never get one —
    -- §B rules out a second identity system — so a decision is attributed the way
    -- 0265 and 0274 attribute one.
    decided_by_name   text NOT NULL DEFAULT '',

    created_by        uuid,
    created_by_name   text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT agency_proposals_proposal_number_prefix_check
        CHECK (proposal_number LIKE 'PR-%'),
    -- `withdrawn` is absent, as on a brief: a draft can be withdrawn without ever
    -- having been sent.
    CONSTRAINT agency_proposals_sent_at_check
        CHECK (status NOT IN ('sent', 'accepted', 'declined', 'expired') OR sent_at IS NOT NULL),
    CONSTRAINT agency_proposals_decision_check
        CHECK (status NOT IN ('accepted', 'declined')
               OR (decided_at IS NOT NULL AND btrim(decided_by_name) <> '')),
    -- Expiry is a date passing, so a row with no date cannot reach this status:
    -- there would be nothing that expired.
    CONSTRAINT agency_proposals_valid_until_check
        CHECK (status <> 'expired' OR valid_until IS NOT NULL),
    UNIQUE (business_id, proposal_number),
    -- So a future register can reference a proposal by composite key, as 0274's
    -- briefs can be.
    UNIQUE (business_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agency_proposals_party
    ON agency_proposals (business_id, party_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agency_proposals_brief
    ON agency_proposals (business_id, brief_id) WHERE brief_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agency_proposals_deal
    ON agency_proposals (business_id, deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agency_proposals_project
    ON agency_proposals (business_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agency_proposals_open
    ON agency_proposals (business_id, status) WHERE status IN ('draft', 'sent');
-- A quote's clock is read, not written: the screens that ask "what lapsed this
-- week?" filter on this and never on a status a job would have to maintain.
CREATE INDEX IF NOT EXISTS idx_agency_proposals_valid_until
    ON agency_proposals (business_id, valid_until) WHERE valid_until IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Its lines
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agency_proposal_lines (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Composite, so a line cannot claim a proposal from another tenant: the pair
    -- has to exist together. `UNIQUE (business_id, id)` on the parent is what
    -- makes this expressible, and it is why 0274 added one.
    proposal_id       uuid NOT NULL,
    line_number       integer NOT NULL CHECK (line_number > 0),

    description       text NOT NULL CHECK (btrim(description) <> ''),
    -- Numeric rather than integer: agency work is sold in halves and thirds —
    -- 1.5 days of art direction, 0.5 of a retainer month.
    quantity          numeric(14, 3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_price_rial   bigint NOT NULL CHECK (unit_price_rial >= 0),
    -- Computed by trigger from the two above. Stored because a list, a print
    -- template and an invoice all need it and none of them should re-derive it
    -- slightly differently.
    amount_rial       bigint NOT NULL DEFAULT 0 CHECK (amount_rial >= 0),

    -- The account this line will credit when it is invoiced. §D's four, and
    -- validated against the tenant's own chart by a trigger copied from 0260: a
    -- line that credits an account this business does not have is an invoice that
    -- cannot be issued later, and the refusal belongs at the moment of the choice.
    revenue_code      text NOT NULL DEFAULT '4640'
                          CHECK (revenue_code IN ('4640', '4650', '4660', '4670')),

    -- INTERNAL. What the agency pays for this line. Never rendered to a client.
    cost_rial         bigint CHECK (cost_rial IS NULL OR cost_rial >= 0),
    -- INTERNAL, and where §D's gross-vs-net question is answered. True means the
    -- money is the client's moving past the agency rather than the agency's own
    -- revenue, which is what decides whether an invoice books it gross or against
    -- the unreached receivable account. Nothing here posts it.
    pass_through      boolean NOT NULL DEFAULT false,

    note              text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fk_agency_proposal_lines_proposal
        FOREIGN KEY (business_id, proposal_id)
        REFERENCES agency_proposals (business_id, id) ON DELETE CASCADE,
    CONSTRAINT agency_proposal_lines_pass_through_needs_cost
        -- A pass-through line with no cost is a recharge of an unknown amount:
        -- the agency would be promising to book the client's money without
        -- knowing how much of it there is.
        CHECK (pass_through = false OR cost_rial IS NOT NULL),
    UNIQUE (proposal_id, line_number),
    UNIQUE (business_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agency_proposal_lines_proposal
    ON agency_proposal_lines (proposal_id, line_number);
-- Margin is read across lines, not down one, so the internal pair is indexed
-- together and never selected without its proposal.
CREATE INDEX IF NOT EXISTS idx_agency_proposal_lines_margin
    ON agency_proposal_lines (business_id, revenue_code) WHERE cost_rial IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Every reference is this tenant's own, and means what it says
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agency_assert_proposal_references_owned() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
    related        integer;
    brief_owner    uuid;
BEGIN
    -- A BEFORE trigger answers before the column's own NOT NULL does, so a
    -- missing client is refused here in words rather than as a constraint
    -- violation — the lesson 0274's harness taught.
    IF NEW.party_id IS NULL THEN
        RAISE EXCEPTION 'agency_proposals: a proposal must name its client'
            USING ERRCODE = '23514';
    END IF;
    SELECT business_id INTO owner_business FROM parties WHERE id = NEW.party_id;
    IF owner_business IS NULL THEN
        RAISE EXCEPTION 'agency_proposals: client does not exist' USING ERRCODE = '23514';
    END IF;
    IF owner_business <> NEW.business_id THEN
        RAISE EXCEPTION 'agency_proposals: client belongs to another business'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.deal_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM crm_deals WHERE id = NEW.deal_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'agency_proposals: opportunity does not exist' USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'agency_proposals: opportunity belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.project_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM ai_projects WHERE id = NEW.project_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'agency_proposals: project does not exist' USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'agency_proposals: project belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.contract_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM workspace_contracts WHERE id = NEW.contract_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'agency_proposals: contract does not exist' USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'agency_proposals: contract belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    -- A proposal prices a brief, and a brief belongs to one client. Pricing
    -- client A's brief for client B is not a typo to be tolerated: it would put
    -- one client's stated requirement inside another client's offer, which is the
    -- leak §A asks to prevent, arriving from the other direction.
    IF NEW.brief_id IS NOT NULL THEN
        SELECT business_id, party_id INTO owner_business, brief_owner
          FROM agency_client_briefs WHERE id = NEW.brief_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'agency_proposals: brief does not exist' USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'agency_proposals: brief belongs to another business'
                USING ERRCODE = '23514';
        END IF;
        IF brief_owner <> NEW.party_id THEN
            RAISE EXCEPTION 'agency_proposals: brief was written for a different client'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    -- §A's stakeholder rule, as 0274 states it: a contact of this client, in
    -- either direction of the relationship, or not an available choice at all.
    IF NEW.client_contact_party_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM parties WHERE id = NEW.client_contact_party_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'agency_proposals: client contact does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'agency_proposals: client contact belongs to another business'
                USING ERRCODE = '23514';
        END IF;

        SELECT count(*) INTO related
          FROM crm_party_relationships
         WHERE business_id = NEW.business_id
           AND ((from_party_id = NEW.client_contact_party_id AND to_party_id = NEW.party_id)
             OR (from_party_id = NEW.party_id AND to_party_id = NEW.client_contact_party_id));
        IF related = 0 THEN
            RAISE EXCEPTION 'agency_proposals: client contact is not a contact of this client'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agency_proposals_references ON agency_proposals;
CREATE TRIGGER trg_agency_proposals_references
    BEFORE INSERT OR UPDATE ON agency_proposals
    FOR EACH ROW EXECUTE FUNCTION agency_assert_proposal_references_owned();

-- The revenue account must be this tenant's own, on insert and whenever the code
-- changes — copied from 0260's milestone trigger for the reason it gives: a line
-- crediting an account this business does not have is an invoice that cannot be
-- issued later, and whether an *inactive* account may still be posted to is the
-- invoice layer's decision rather than this row's.
CREATE OR REPLACE FUNCTION agency_assert_proposal_line_revenue_account() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.revenue_code IS DISTINCT FROM OLD.revenue_code
       OR NEW.business_id IS DISTINCT FROM OLD.business_id THEN
        -- Two different problems, and the column's own CHECK cannot separate
        -- them because this trigger runs first. A code outside the vocabulary is
        -- not something the tenant could ever add to its chart, and telling them
        -- otherwise sends them looking for an account that must not exist.
        IF NEW.revenue_code NOT IN ('4640', '4650', '4660', '4670') THEN
            RAISE EXCEPTION 'agency_proposal_lines: % is not an agency revenue account (4640, 4650, 4660, 4670)',
                NEW.revenue_code
                USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM accounts a
             WHERE a.business_id = NEW.business_id AND a.code = NEW.revenue_code
        ) THEN
            RAISE EXCEPTION 'agency_proposal_lines: revenue account % is not in this business''s chart of accounts',
                NEW.revenue_code
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_agency_proposal_lines_revenue_account ON agency_proposal_lines;
CREATE TRIGGER trg_agency_proposal_lines_revenue_account
    BEFORE INSERT OR UPDATE ON agency_proposal_lines
    FOR EACH ROW EXECUTE FUNCTION agency_assert_proposal_line_revenue_account();

-- ---------------------------------------------------------------------------
-- 4. The freeze: what the client is reading, and the offer's own shape
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agency_proposal_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    line_count integer;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            -- A client being deleted takes its proposals with it, exactly as it
            -- takes its briefs: with no counterparty left there is nobody for the
            -- offer to be addressed to, and refusing would let one sent proposal
            -- block the deletion of the client it was sent to. Absence of the
            -- party is what distinguishes that cascade from a direct delete — the
            -- test 0265's item guard and 0274's brief guard both apply.
            IF EXISTS (SELECT 1 FROM parties WHERE id = OLD.party_id) THEN
                RAISE EXCEPTION 'agency_proposals: only a draft proposal can be deleted'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Everything the client reads is frozen once it has been sent, because a
        -- proposal states a price. The status chain, its own stamps and
        -- `contract_id` still move: accepting, declining and recording what the
        -- offer became are the point, and the contract is written afterwards.
        IF OLD.status <> 'draft' THEN
            IF NEW.title IS DISTINCT FROM OLD.title
               OR NEW.scope_of_work IS DISTINCT FROM OLD.scope_of_work
               OR NEW.terms IS DISTINCT FROM OLD.terms
               OR NEW.discount_rial IS DISTINCT FROM OLD.discount_rial
               OR NEW.tax_rial IS DISTINCT FROM OLD.tax_rial
               OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
               OR NEW.party_id IS DISTINCT FROM OLD.party_id
               OR NEW.brief_id IS DISTINCT FROM OLD.brief_id
               OR NEW.client_contact_party_id IS DISTINCT FROM OLD.client_contact_party_id
               OR NEW.client_contact_name IS DISTINCT FROM OLD.client_contact_name THEN
                RAISE EXCEPTION 'agency_proposals: a sent proposal is frozen; issue a new one to change the offer'
                    USING ERRCODE = '23514';
            END IF;
        END IF;

        -- An offer with nothing on it is not an offer. Checked on the way out of
        -- `draft` rather than on insert, because a proposal is built line by line
        -- and the first save legitimately has none.
        IF OLD.status = 'draft' AND NEW.status <> 'draft' THEN
            SELECT count(*) INTO line_count
              FROM agency_proposal_lines WHERE proposal_id = NEW.id;
            IF line_count = 0 THEN
                RAISE EXCEPTION 'agency_proposals: a proposal needs at least one line before it is sent'
                    USING ERRCODE = '23514';
            END IF;
        END IF;

        IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS NULL THEN
            RAISE EXCEPTION 'agency_proposals: sent_at cannot be cleared' USING ERRCODE = '23514';
        END IF;
        IF OLD.decided_at IS NOT NULL AND NEW.decided_at IS NULL THEN
            RAISE EXCEPTION 'agency_proposals: decided_at cannot be cleared' USING ERRCODE = '23514';
        END IF;

        NEW.updated_at := now();
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agency_proposals_guard ON agency_proposals;
CREATE TRIGGER trg_agency_proposals_guard
    BEFORE UPDATE OR DELETE ON agency_proposals
    FOR EACH ROW EXECUTE FUNCTION agency_proposal_guard();

-- The lines are the price, so they freeze with it — and the last one cannot be
-- taken off a sent offer, which would be the same change by another route.
--
-- Freezing and computing the amount live in ONE function, and the freeze runs
-- first, because Postgres fires same-timing row triggers in alphabetical order
-- by trigger name: as two functions, whichever sorted first would answer, and a
-- reader adding a line to an already-sent offer could be told about the line's
-- arithmetic instead of about the fact that the offer is closed. Ordering by
-- name is not a contract to build on, so there is one name.
CREATE OR REPLACE FUNCTION agency_proposal_line_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    proposal_status text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT status INTO proposal_status FROM agency_proposals WHERE id = OLD.proposal_id;
        -- No proposal means this delete is the cascade from deleting the proposal
        -- itself, which the proposal guard already limits to drafts (or to a
        -- client being deleted).
        IF NOT FOUND THEN
            RETURN OLD;
        END IF;
        IF proposal_status <> 'draft' THEN
            RAISE EXCEPTION 'agency_proposal_lines: a sent proposal''s lines are frozen'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    SELECT status INTO proposal_status FROM agency_proposals WHERE id = NEW.proposal_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'agency_proposal_lines: proposal does not exist' USING ERRCODE = '23514';
    END IF;
    IF proposal_status <> 'draft' THEN
        RAISE EXCEPTION 'agency_proposal_lines: a sent proposal''s lines are frozen'
            USING ERRCODE = '23514';
    END IF;

    -- Refuse the impossible inputs in words before deriving anything from them.
    -- Both columns carry their own CHECK, but a BEFORE trigger runs before
    -- Postgres enforces one, and computing first would report a negative unit
    -- price as a violation of `amount_rial >= 0` — a true statement about a
    -- number nobody asked for, and a misleading answer to the person who typed
    -- it. The CHECKs stay: they are the structural invariant, and still hold if
    -- this trigger is ever dropped.
    IF NEW.quantity IS NULL OR NEW.quantity <= 0 THEN
        RAISE EXCEPTION 'agency_proposal_lines: quantity must be greater than zero'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.unit_price_rial IS NULL OR NEW.unit_price_rial < 0 THEN
        RAISE EXCEPTION 'agency_proposal_lines: unit_price_rial cannot be negative'
            USING ERRCODE = '23514';
    END IF;

    -- Rounded half-up to whole rial, because the column is a bigint and every
    -- other money figure in the product is. Computing it here rather than
    -- accepting it means quantity, unit price and amount can never disagree —
    -- and a disagreement between the three is invisible on a printed quote,
    -- where a reader sees a total and believes it.
    NEW.amount_rial := round(NEW.quantity * NEW.unit_price_rial)::bigint;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agency_proposal_line_guard ON agency_proposal_lines;
CREATE TRIGGER trg_agency_proposal_line_guard
    BEFORE INSERT OR UPDATE OR DELETE ON agency_proposal_lines
    FOR EACH ROW EXECUTE FUNCTION agency_proposal_line_guard();

-- ---------------------------------------------------------------------------
-- 5. Tenant isolation
-- ---------------------------------------------------------------------------
-- Both tables carry `business_id`, so both are RLS shape 1: the standard
-- `tenant_isolation` policy, fail-closed when `app.business_id` is unset, exactly
-- as 0260's and 0274's registers are. Without it, isolation would be a property
-- of every route handler that reads a proposal rather than of the database — and
-- `cost_rial` is the one column in this migration where that distinction is worth
-- money rather than merely worth embarrassment.
ALTER TABLE agency_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agency_proposals;
CREATE POLICY tenant_isolation ON agency_proposals FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE agency_proposal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_proposal_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agency_proposal_lines;
CREATE POLICY tenant_isolation ON agency_proposal_lines FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
