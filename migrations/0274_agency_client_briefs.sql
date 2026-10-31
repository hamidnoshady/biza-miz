-- ============================================================================
-- 0274_agency_client_briefs.sql — issue #1128 §A: what the client actually asked
-- for, recorded before anybody prices or builds it.
--
-- §A names "client briefs" in the sales pipeline, and §B lists `brief` among the
-- project metadata an agency carries. Both are the same document at two moments:
-- it is written against an opportunity while the deal is still open, and it is
-- what the project then delivers against. One table with two nullable pointers
-- is that lifecycle; two tables would be the same brief in two places, able to
-- disagree about what the client wanted.
--
-- WHY THIS IS A TABLE AND NOT A NOTE. A brief is the only record of the
-- requirement that is *the client's* rather than the agency's. Everything
-- downstream is measured against it: a proposal prices it, a project delivers
-- it, a change request departs from it, and an argument about scope is settled
-- by it. A note on a deal or a document in the project's files cannot carry
-- that, because neither can say whether the client confirmed it or when.
--
-- WHY IT IS NOT `crm_custom_fields`. The platform's custom fields could hold
-- these values per tenant, and a tenant may still add them. But a brief has a
-- lifecycle of its own — drafted, sent to the client, confirmed by a named
-- person, later superseded — and custom-field values have no status, no stamps
-- and no freeze. What makes a brief worth anything is that it is the version the
-- client confirmed, which is a fact about time rather than a value.
--
-- FIVE RULES THIS FILE EXISTS TO ENFORCE, in the database rather than only in
-- the service:
--
--   * A BRIEF BELONGS TO A CLIENT. `party_id` is NOT NULL: a brief with no
--     client is the agency guessing, which is the thing a brief exists to stop.
--     The deal and the project are both optional, because a brief is written
--     before either exists more often than not.
--   * EVERY REFERENCE IS THIS TENANT'S OWN. A trigger asserts the client, the
--     deal, the project and the approver all belong to `business_id`, exactly as
--     0265 does for a review round's scope. `crm_deals` has no
--     `UNIQUE(business_id, id)` to make a composite key possible, so this is a
--     trigger rather than a foreign key — the same reasoning 0260 records for
--     `orders`.
--   * THE APPROVER MUST BE RELATED TO THIS BRIEF'S OWN CLIENT. §A asks that a
--     "stakeholder/approver contact is recorded without exposing another
--     client's information", and that is a constraint rather than a convention:
--     naming another client's decision-maker as this brief's approver would put
--     one client's contact on another client's document. The trigger requires an
--     edge in `crm_party_relationships` between the two, in either direction.
--   * WHAT THE CLIENT CONFIRMED IS FROZEN. A confirmed brief is the agreed
--     requirement; editing it afterwards would make every proposal, project and
--     change request that cites it cite something that no longer says what they
--     read. The status chain and its own stamps still move — confirming, then
--     superseding, is the point — but the substance does not. A correction is a
--     new brief that supersedes this one, which is also what leaves the trail.
--   * A CONFIRMED BRIEF HAS SOMETHING IN IT. Confirming an empty objective is
--     confirming nothing, so `sent` and `confirmed` both require one. The
--     coupling is a CHECK rather than a service rule because the service is one
--     of several ways a row can be written.
--
-- NOTHING HERE POSTS A JOURNAL ENTRY, and nothing here prices anything. A brief
-- records a requirement; `budget_rial` is what the client says they intend to
-- spend, which is an input to a proposal and never a receivable. §D's registers
-- own the money, and a brief that also owned money would be a second answer to
-- "how much".
--
-- `created_by` carries no foreign key, matching 0260's two registers: the row
-- snapshots `created_by_name` for display, and a member's deletion is then a
-- matter for the member-history sweep rather than a dangling reference here.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The register
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agency_client_briefs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    brief_number      text NOT NULL CHECK (btrim(brief_number) <> ''),

    -- Whose brief this is, and therefore whose requirement it records.
    party_id          uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    -- Both optional, and optional in both directions of the lifecycle: written
    -- against an opportunity while it is open (§A's «بریف کارفرما» stage), then
    -- carried by the project it becomes (§B's `brief` metadata). `SET NULL`
    -- rather than `CASCADE` because a brief outlives either: it is the record of
    -- what was asked for, and a lost deal or a cancelled project does not unask
    -- it.
    deal_id           uuid REFERENCES crm_deals(id) ON DELETE SET NULL,
    project_id        uuid REFERENCES ai_projects(id) ON DELETE SET NULL,

    title             text NOT NULL CHECK (btrim(title) <> ''),
    status            text NOT NULL DEFAULT 'draft'
                          CHECK (status IN (
                              'draft', 'sent', 'confirmed', 'superseded', 'withdrawn'
                          )),

    -- The substance. Deliberately columns rather than one jsonb blob: these are
    -- the fields a proposal is priced from and a dispute is settled by, so they
    -- have to be readable in a query, filterable in a list and freezable by the
    -- guard below. A blob would make "which briefs mention this audience" a scan
    -- and "freeze what the client confirmed" impossible to state.
    objective         text NOT NULL DEFAULT '',
    audience          text NOT NULL DEFAULT '',
    -- Vocabulary keys, validated by `agency-brief.ts` rather than by a CHECK:
    -- the channel list is metadata that grows with the trade, and widening a
    -- CHECK is a migration while widening a vocabulary is a line.
    channels          text[] NOT NULL DEFAULT '{}',
    -- A list of {title, format?, quantity?}, where `format` is §E's own
    -- `AGENCY_MEDIA_FORMATS` vocabulary — the same words that label a review
    -- round's items, so what a brief asks for and what a client later approves
    -- are described in one language. Shape is checked here; contents in code.
    deliverables      jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- What the client says they intend to spend. An input to a proposal, never a
    -- receivable and never a figure anything posts.
    budget_rial       bigint,
    start_date        date,
    delivery_date     date,
    acceptance_criteria text NOT NULL DEFAULT '',
    note              text NOT NULL DEFAULT '',

    -- §A's stakeholder/approver. A contact of the client, not a member of the
    -- agency, and the trigger below requires the relationship to exist.
    approver_party_id uuid REFERENCES parties(id) ON DELETE SET NULL,
    approver_name     text NOT NULL DEFAULT '',

    sent_at           timestamptz,
    confirmed_at      timestamptz,
    -- Who confirmed it, as a name. The client has no user row and must never get
    -- one — §B rules out a second identity system — so the confirmation is
    -- attributed the same way §E attributes a client's decision.
    confirmed_by_name text NOT NULL DEFAULT '',

    created_by        uuid,
    created_by_name   text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- Named `_prefix_check` rather than `_brief_number_check`: the column-level
    -- non-empty CHECK above already claims that auto-generated name.
    CONSTRAINT agency_client_briefs_brief_number_prefix_check
        CHECK (brief_number LIKE 'BR-%'),
    CONSTRAINT agency_client_briefs_deliverables_check CHECK (jsonb_typeof(deliverables) = 'array'),
    CONSTRAINT agency_client_briefs_budget_rial_check
        CHECK (budget_rial IS NULL OR budget_rial > 0),
    CONSTRAINT agency_client_briefs_delivery_date_check
        CHECK (start_date IS NULL OR delivery_date IS NULL OR delivery_date >= start_date),
    -- A brief that was sent was sent at some point; `withdrawn` is deliberately
    -- absent, because a draft can be withdrawn without ever having been sent.
    CONSTRAINT agency_client_briefs_sent_at_check
        CHECK (status NOT IN ('sent', 'confirmed', 'superseded') OR sent_at IS NOT NULL),
    -- Only a brief the client confirmed can be superseded: otherwise a draft was
    -- simply edited, which needs no state at all.
    CONSTRAINT agency_client_briefs_superseded_check
        CHECK (status <> 'superseded' OR confirmed_at IS NOT NULL),
    CONSTRAINT agency_client_briefs_confirmed_at_check
        CHECK (status <> 'confirmed'
               OR (confirmed_at IS NOT NULL AND btrim(confirmed_by_name) <> '')),
    -- Confirming an empty objective is confirming nothing.
    CONSTRAINT agency_client_briefs_objective_check
        CHECK (status NOT IN ('sent', 'confirmed') OR btrim(objective) <> ''),
    -- One number per agency, so a brief is unambiguous outside its client's file.
    UNIQUE (business_id, brief_number),
    -- So a future table can reference a brief by composite key, as 0260's
    -- registers are referenced.
    UNIQUE (business_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agency_client_briefs_party
    ON agency_client_briefs (business_id, party_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agency_client_briefs_deal
    ON agency_client_briefs (business_id, deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agency_client_briefs_project
    ON agency_client_briefs (business_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agency_client_briefs_open
    ON agency_client_briefs (business_id, status) WHERE status IN ('draft', 'sent');

-- ---------------------------------------------------------------------------
-- 2. Every reference is this tenant's own
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agency_assert_brief_references_owned() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
    related        integer;
BEGIN
    -- This runs before the NOT NULL constraint does, so a missing client is
    -- refused here; saying it plainly beats the constraint's generic message.
    IF NEW.party_id IS NULL THEN
        RAISE EXCEPTION 'agency_client_briefs: a brief must name its client'
            USING ERRCODE = '23514';
    END IF;
    SELECT business_id INTO owner_business FROM parties WHERE id = NEW.party_id;
    IF owner_business IS NULL THEN
        RAISE EXCEPTION 'agency_client_briefs: client does not exist'
            USING ERRCODE = '23514';
    END IF;
    IF owner_business <> NEW.business_id THEN
        RAISE EXCEPTION 'agency_client_briefs: client belongs to another business'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.deal_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM crm_deals WHERE id = NEW.deal_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'agency_client_briefs: opportunity does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'agency_client_briefs: opportunity belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.project_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM ai_projects WHERE id = NEW.project_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'agency_client_briefs: project does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'agency_client_briefs: project belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    -- The approver is a contact, so two things have to hold: they belong to this
    -- tenant, and they are related to *this brief's* client. The second is §A's
    -- "without exposing another client's information" stated as a constraint —
    -- without it, one client's decision-maker could be recorded on another
    -- client's brief, and every screen that renders the approver would then be
    -- showing one client's contact inside another client's file.
    IF NEW.approver_party_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM parties WHERE id = NEW.approver_party_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'agency_client_briefs: approver does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'agency_client_briefs: approver belongs to another business'
                USING ERRCODE = '23514';
        END IF;

        SELECT count(*) INTO related
          FROM crm_party_relationships
         WHERE business_id = NEW.business_id
           AND ((from_party_id = NEW.approver_party_id AND to_party_id = NEW.party_id)
             OR (from_party_id = NEW.party_id AND to_party_id = NEW.approver_party_id));
        IF related = 0 THEN
            RAISE EXCEPTION 'agency_client_briefs: approver is not a contact of this client'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agency_client_briefs_references ON agency_client_briefs;
CREATE TRIGGER trg_agency_client_briefs_references
    BEFORE INSERT OR UPDATE ON agency_client_briefs
    FOR EACH ROW EXECUTE FUNCTION agency_assert_brief_references_owned();

-- ---------------------------------------------------------------------------
-- 3. What the client confirmed is frozen
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agency_client_brief_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            -- A client being deleted takes its briefs with it, exactly as it takes
            -- its deals and its projects: with no counterparty left there is nobody
            -- for the record to speak for, and refusing would make a confirmed
            -- brief block the deletion of the very client it belongs to. Absence of
            -- the party is what distinguishes that cascade from a direct delete —
            -- the same test 0265's item guard applies to its round.
            IF EXISTS (SELECT 1 FROM parties WHERE id = OLD.party_id) THEN
                RAISE EXCEPTION 'agency_client_briefs: only a draft brief can be deleted'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Once the client has confirmed it, the substance is history: a proposal
        -- priced it, a project may be delivering against it, and a change request
        -- departs from it. The status chain and its own stamps still move, since
        -- confirming and then superseding is the whole point. A correction is a
        -- new brief that supersedes this one — which is also what leaves a trail,
        -- where an edit in place would leave none.
        IF OLD.status IN ('confirmed', 'superseded') THEN
            IF NEW.title IS DISTINCT FROM OLD.title
               OR NEW.objective IS DISTINCT FROM OLD.objective
               OR NEW.audience IS DISTINCT FROM OLD.audience
               OR NEW.channels IS DISTINCT FROM OLD.channels
               OR NEW.deliverables IS DISTINCT FROM OLD.deliverables
               OR NEW.budget_rial IS DISTINCT FROM OLD.budget_rial
               OR NEW.start_date IS DISTINCT FROM OLD.start_date
               OR NEW.delivery_date IS DISTINCT FROM OLD.delivery_date
               OR NEW.acceptance_criteria IS DISTINCT FROM OLD.acceptance_criteria
               OR NEW.approver_party_id IS DISTINCT FROM OLD.approver_party_id
               OR NEW.approver_name IS DISTINCT FROM OLD.approver_name
               OR NEW.party_id IS DISTINCT FROM OLD.party_id THEN
                RAISE EXCEPTION 'agency_client_briefs: a confirmed brief is frozen'
                    USING ERRCODE = '23514';
            END IF;
        END IF;

        -- `deal_id` and `project_id` are deliberately NOT frozen, by the same
        -- reasoning that leaves 0260's `invoice_order_id` writable after its
        -- milestone is approved: they say where the work lives, not what the
        -- client agreed to. A brief is normally confirmed while it still belongs
        -- only to an opportunity, and the project it becomes is created
        -- afterwards — freezing the pointer would break the §A→§B handoff, which
        -- is the one transition this table exists to serve. The client's own
        -- identity (`party_id`) *is* frozen: a brief confirmed by one client
        -- cannot be re-filed as another's.

        -- A brief that was sent was sent once. Re-sending a correction is a new
        -- brief, so this stamp is a fact about the first time the client saw it
        -- rather than a property of the current draft — the same rule §E applies
        -- to a review round's `sent_at`.
        IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS NULL THEN
            RAISE EXCEPTION 'agency_client_briefs: sent_at cannot be cleared'
                USING ERRCODE = '23514';
        END IF;
        IF OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NULL THEN
            RAISE EXCEPTION 'agency_client_briefs: confirmed_at cannot be cleared'
                USING ERRCODE = '23514';
        END IF;

        NEW.updated_at := now();
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agency_client_briefs_guard ON agency_client_briefs;
CREATE TRIGGER trg_agency_client_briefs_guard
    BEFORE UPDATE OR DELETE ON agency_client_briefs
    FOR EACH ROW EXECUTE FUNCTION agency_client_brief_guard();

-- ---------------------------------------------------------------------------
-- 4. Tenant isolation
-- ---------------------------------------------------------------------------
-- The register carries `business_id` directly, so it is RLS shape 1: the standard
-- `tenant_isolation` policy, fail-closed when `app.business_id` is unset, exactly
-- as 0260's two registers are. Without this, isolation would be a property of
-- every route handler that reads a brief rather than a property of the database.
ALTER TABLE agency_client_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_client_briefs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agency_client_briefs;
CREATE POLICY tenant_isolation ON agency_client_briefs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
