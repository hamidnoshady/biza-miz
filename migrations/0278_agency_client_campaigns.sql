-- ============================================================================
-- 0278_agency_client_campaigns.sql — the campaign as it ran, for a client.
--
-- Issue #1128 §A: "client accounts can have multiple brands and **concurrent
-- campaigns**". §C: "campaign calendar and channel mix for *client* campaigns,
-- the agency's-own vs client-managed split in reporting, spend/reach/CPL/CPA/ROAS
-- with defensible attribution, manual import of platform data."
--
-- ## Why this is a new table and not a column on `growth_campaigns`
--
-- Wave 8 established that `growth_campaigns` has no client column, and recorded
-- the tempting conclusion that §C was therefore "blocked on a missing dimension"
-- on that table. Reading #901's builder before adding anything showed that
-- conclusion was wrong in a way that would have been expensive: `growth_campaigns`
-- is a **retail cashback automation**. Its trigger vocabulary is exactly
-- `pos_sale_settled`, its reward vocabulary is exactly `cashback`, and its basis
-- is `net_paid` — a rule that pays a *shopper* back on a settled sale. The party
-- in that record is the customer earning cashback, not a client an agency serves,
-- and an agency tenant has no settled POS sales to trigger it.
--
-- Adding `party_id` there would not have been a small extension. It would have
-- given one column two meanings in two trades — "the shopper this reward fires
-- for" and "the client this media plan belongs to" — and every future reader of
-- `growth_campaigns.party_id` would have to know which trade they were in to know
-- which they had. §C's campaign is a different noun with a different lifecycle and
-- a different app, so it gets its own table.
--
-- Nor is it `message_campaigns`, which is an SMS broadcast with its own credit
-- ledger and billing, and not `media_review_rounds`, which is §E's approval of
-- deliverables. Those three and this one are four records that all get called a
-- campaign in Persian and none of which substitute for another.
--
-- ## What this record is
--
-- The brief (0274) is what the client asked for; the proposal (0276) is what the
-- agency offered at a price; the contract is what was signed; the project
-- (`ai_projects`) is the work. **This is the campaign that ran** — a window, the
-- channels it ran on, the media money that went out, and the figures that came
-- back. It is the record §A's "concurrent campaigns" counts and §C's reporting
-- splits, and it is downstream of all four of the others, which is why it can
-- point at any of them.
--
-- ## Three decisions worth finding here rather than in a commit message
--
-- **An overspend is recordable.** `spend_rial` is not CHECKed against
-- `budget_rial`. A campaign that overran its media budget did so, and refusing to
-- store the true figure would push it into a note where no report can see it — the
-- ledger would balance and lie at the same time. The screen flags the overrun; the
-- database records it.
--
-- **`metrics_source` has two values, and that is the documentation.** §C forbids
-- "fake campaign performance or integrations", and no ad-platform integration
-- exists in this codebase. So the vocabulary is `manual` (a member typed it) and
-- `imported` (a member pasted or uploaded a platform's own export) — there is no
-- `platform` value, because there is no platform connection to have come from. A
-- CHECK is the one place that cannot drift out of date.
--
-- **Attribution figures are a member's claim, not a computed tie-out.** §C asks
-- for "defensible attribution", and the only honest way to offer that without
-- inventing an attribution engine is to store the numbers, store where they came
-- from, and store `metrics_note` for how they were derived. Nothing posts from
-- them and nothing reconciles them to `orders`; a ROAS computed here is a figure a
-- person vouched for, and the columns say so.
--
-- Additive: a new table, its RLS, two triggers. No backfill, no existing row
-- touched, and no campaign is inferred for any tenant that does not create one.
-- ============================================================================

CREATE TABLE agency_client_campaigns (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    campaign_number   text NOT NULL CHECK (char_length(btrim(campaign_number)) BETWEEN 1 AND 24),

    -- The client — which, since wave 8, may be a brand of a group rather than the
    -- group itself. That is the point: «مهر فود»'s spring campaign and «مهر کیمیا»'s
    -- are two rows here and one relationship edge apart on the client's file.
    party_id          uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,

    title             text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
    status            text NOT NULL DEFAULT 'planned'
                      CHECK (status IN ('planned', 'running', 'paused', 'completed', 'cancelled')),

    -- The substance, as columns rather than a blob, for the reason 0274 gives:
    -- these are the fields a report groups by and a client dispute is settled
    -- with, so they have to be readable in a query and filterable in a list.
    objective         text NOT NULL DEFAULT '',
    -- Vocabulary keys from `AGENCY_BRIEF_CHANNELS`, validated in
    -- `agency-campaign.ts` rather than by a CHECK — the same choice 0274 made,
    -- because widening a CHECK is a migration and widening a vocabulary is a line.
    -- Reusing the brief's list rather than growing a second one is deliberate: a
    -- campaign that ran on channels the brief never named is a conversation, and
    -- two vocabularies would make that comparison impossible to write.
    channels          text[] NOT NULL DEFAULT '{}',

    start_date        date,
    end_date          date,

    -- What the client agreed to spend on media. An input, never a receivable —
    -- 0274's rule for the same field, and the reason nothing posts from it.
    budget_rial       bigint,
    -- What actually went out. Deliberately *not* CHECKed against the budget: see
    -- the header. An overrun is a fact about the campaign, not an invalid row.
    spend_rial        bigint NOT NULL DEFAULT 0 CHECK (spend_rial >= 0),

    -- The figures that came back, and the honest limits on them. `clicks` cannot
    -- exceed `impressions` because that is arithmetic, not attribution; nothing
    -- here claims `leads_generated` caused anything, which is why `metrics_note`
    -- and `metrics_source` exist beside it.
    --
    -- Both counters default to 0 rather than being nullable, so 0 means "not
    -- recorded" as well as "none" — and the CHECK between them is therefore best
    -- read as "you cannot report clicks without reporting impressions". A member
    -- holding a platform export that gives one and not the other is stuck, and
    -- that is the intended kind of stuck: the alternative is a CPL computed from a
    -- click count nobody can check against anything.
    impressions       bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
    clicks            bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0 AND clicks <= impressions),
    leads_generated   integer NOT NULL DEFAULT 0 CHECK (leads_generated >= 0),
    conversions       integer NOT NULL DEFAULT 0 CHECK (conversions >= 0),
    -- Revenue a member attributes to this campaign, for a ROAS they vouch for.
    -- Nullable because "we do not know yet" and "zero" are different claims.
    revenue_rial      bigint CHECK (revenue_rial IS NULL OR revenue_rial >= 0),
    metrics_source    text NOT NULL DEFAULT 'manual' CHECK (metrics_source IN ('manual', 'imported')),
    metrics_note      text NOT NULL DEFAULT '',

    note              text NOT NULL DEFAULT '',

    -- Downstream of all four, so it may point at any of them. Every one is a
    -- *simple* FK plus the ownership trigger below, because a composite
    -- `(business_id, …)` FK cannot use ON DELETE SET NULL while `business_id` is
    -- NOT NULL — the constraint 0276 hit on `brief_id`, and the reason that
    -- migration's brief reference is simple too.
    brief_id          uuid REFERENCES agency_client_briefs(id) ON DELETE SET NULL,
    proposal_id       uuid REFERENCES agency_proposals(id) ON DELETE SET NULL,
    deal_id           uuid REFERENCES crm_deals(id) ON DELETE SET NULL,
    project_id        uuid REFERENCES ai_projects(id) ON DELETE SET NULL,
    contract_id       uuid REFERENCES workspace_contracts(id) ON DELETE SET NULL,

    -- Who runs it, as a name. A bare uuid and no `REFERENCES users(id)`, which is
    -- the choice 0276 made for `created_by`: this column is not part of a member's
    -- history, and pointing it at `users` would enrol it in the whole-schema
    -- member-history contract for no benefit to either.
    owner_name        text NOT NULL DEFAULT '',
    created_by        uuid,
    created_by_name   text NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- Named `_prefix_check`: the column-level non-empty CHECK above already owns
    -- the auto-generated `_campaign_number_check` name, and colliding with it is
    -- `42710` rather than a warning.
    CONSTRAINT agency_client_campaigns_campaign_number_prefix_check
        CHECK (campaign_number LIKE 'CA-%'),
    CONSTRAINT agency_client_campaigns_objective_check
        CHECK (char_length(objective) <= 2000),
    CONSTRAINT agency_client_campaigns_note_check
        CHECK (char_length(note) <= 4000),
    CONSTRAINT agency_client_campaigns_metrics_note_check
        CHECK (char_length(metrics_note) <= 2000),
    CONSTRAINT agency_client_campaigns_owner_name_check
        CHECK (char_length(owner_name) <= 200),
    CONSTRAINT agency_client_campaigns_budget_rial_check
        CHECK (budget_rial IS NULL OR budget_rial > 0),
    CONSTRAINT agency_client_campaigns_window_check
        CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
    -- A campaign that has run has a beginning. Without this, `running` is a status
    -- a member can set on a record with no window, and every report that groups by
    -- month silently drops it.
    CONSTRAINT agency_client_campaigns_started_check
        CHECK (status NOT IN ('running', 'paused', 'completed') OR start_date IS NOT NULL),
    -- A campaign that *finished* has an end. `cancelled` deliberately does not:
    -- a campaign cancelled while still planned never ran, and demanding an end
    -- date for it would have a member invent one — which is the smaller version of
    -- the fake performance figure §C forbids.
    CONSTRAINT agency_client_campaigns_stopped_check
        CHECK (status <> 'completed' OR end_date IS NOT NULL),
    UNIQUE (business_id, campaign_number),
    UNIQUE (business_id, id)
);

CREATE INDEX idx_agency_campaigns_business_party
    ON agency_client_campaigns (business_id, party_id, start_date DESC);
CREATE INDEX idx_agency_campaigns_business_status
    ON agency_client_campaigns (business_id, status, start_date DESC);
-- §C's split and the calendar both read a window, so the window is indexed rather
-- than derived: a campaign current on a date is the query a calendar runs.
CREATE INDEX idx_agency_campaigns_business_window
    ON agency_client_campaigns (business_id, start_date, end_date);
CREATE INDEX idx_agency_campaigns_brief ON agency_client_campaigns (brief_id) WHERE brief_id IS NOT NULL;
CREATE INDEX idx_agency_campaigns_proposal ON agency_client_campaigns (proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX idx_agency_campaigns_project ON agency_client_campaigns (project_id) WHERE project_id IS NOT NULL;

ALTER TABLE agency_client_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_client_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agency_client_campaigns FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- References: every pointer exists, belongs to this business, and belongs to the
-- same client.
-- ---------------------------------------------------------------------------
-- The last of those is §A's rule, and it is the one that makes "multiple brands"
-- safe rather than merely possible. 0274 requires an approver to be a contact of
-- the brief's client and 0276 requires the same of a proposal's; this requires
-- that a campaign's brief and proposal be *that campaign's client's* documents.
-- Without it, «مهر فود»'s campaign can carry «مهر کیمیا»'s accepted proposal, and
-- the two brands' figures merge in every report §C is meant to keep apart.
CREATE OR REPLACE FUNCTION agency_assert_campaign_references_owned()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    owner_business uuid;
    ref_party      uuid;
BEGIN
    IF NEW.party_id IS NULL THEN
        RAISE EXCEPTION 'a campaign needs a client'
            USING ERRCODE = '23514';
    END IF;

    SELECT business_id INTO owner_business FROM parties WHERE id = NEW.party_id;
    IF owner_business IS NULL OR owner_business <> NEW.business_id THEN
        RAISE EXCEPTION 'client % does not belong to this business', NEW.party_id
            USING ERRCODE = '23514';
    END IF;

    IF NEW.brief_id IS NOT NULL THEN
        SELECT business_id, party_id INTO owner_business, ref_party
          FROM agency_client_briefs WHERE id = NEW.brief_id;
        IF owner_business IS NULL OR owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'brief % does not belong to this business', NEW.brief_id
                USING ERRCODE = '23514';
        END IF;
        IF ref_party IS DISTINCT FROM NEW.party_id THEN
            RAISE EXCEPTION 'brief % belongs to a different client', NEW.brief_id
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.proposal_id IS NOT NULL THEN
        SELECT business_id, party_id INTO owner_business, ref_party
          FROM agency_proposals WHERE id = NEW.proposal_id;
        IF owner_business IS NULL OR owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'proposal % does not belong to this business', NEW.proposal_id
                USING ERRCODE = '23514';
        END IF;
        IF ref_party IS DISTINCT FROM NEW.party_id THEN
            RAISE EXCEPTION 'proposal % belongs to a different client', NEW.proposal_id
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.deal_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM crm_deals WHERE id = NEW.deal_id;
        IF owner_business IS NULL OR owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'deal % does not belong to this business', NEW.deal_id
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.project_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM ai_projects WHERE id = NEW.project_id;
        IF owner_business IS NULL OR owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'project % does not belong to this business', NEW.project_id
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.contract_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM workspace_contracts WHERE id = NEW.contract_id;
        IF owner_business IS NULL OR owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'contract % does not belong to this business', NEW.contract_id
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_agency_client_campaigns_references
    BEFORE INSERT OR UPDATE OF party_id, brief_id, proposal_id, deal_id, project_id, contract_id
    ON agency_client_campaigns
    FOR EACH ROW
    EXECUTE FUNCTION agency_assert_campaign_references_owned();

-- ---------------------------------------------------------------------------
-- Lifecycle: what a status change is allowed to take with it.
-- ---------------------------------------------------------------------------
-- One function rather than a freeze trigger and a status trigger, because
-- same-timing row triggers fire alphabetically by name and that is not a contract
-- anybody should rely on — 0276's decision 48. The order inside is the point:
-- the closed-record check runs first, so editing a completed campaign is reported
-- as "this campaign is closed" rather than as whatever arithmetic the edit
-- happens to break.
CREATE OR REPLACE FUNCTION agency_client_campaign_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_cascade boolean;
BEGIN
    -- On DELETE: a campaign may be deleted while it is still `planned`. Once it
    -- has run, its figures are what the client was reported and deleting it would
    -- remove the evidence. The exception is the cascade: when the client itself is
    -- gone there is nothing left to protect, and refusing would make an ordinary
    -- party deletion fail on its own children — 0265's idiom.
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM parties WHERE id = OLD.party_id) THEN
            RETURN OLD;
        END IF;
        IF OLD.status <> 'planned' THEN
            RAISE EXCEPTION 'only a planned campaign can be deleted; this one is %', OLD.status
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    -- `completed` and `cancelled` are terminal. Not because the campaign cannot be
    -- reopened in principle, but because its figures have been reported: a completed
    -- campaign whose numbers quietly change afterwards makes every report that cited
    -- them wrong, and unlike a proposal there is no client-facing document to
    -- supersede. A correction is a new campaign that references the old one.
    IF OLD.status IN ('completed', 'cancelled') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'a % campaign cannot change status', OLD.status
            USING ERRCODE = '23514';
    END IF;

    IF OLD.status IN ('completed', 'cancelled') THEN
        -- The freeze covers the substance and the figures, which are what a report
        -- cited. It must not cover a reference the *database* cleared, because
        -- every one of these FKs is ON DELETE SET NULL: refusing the change would
        -- make a completed campaign block the deletion of the brief it came from,
        -- the project it ran under and the proposal it was priced by. That is the
        -- deadlock 0265 exists to avoid, arriving from the other side.
        --
        -- The exception is narrow and provable rather than a blanket "NULL is
        -- always fine": a cleared reference is a cascade only when the row it
        -- pointed at is *gone*. A member clearing a live reference on a closed
        -- campaign is still refused, because that one does destroy provenance.
        IF NEW.title IS DISTINCT FROM OLD.title
           OR NEW.objective IS DISTINCT FROM OLD.objective
           OR NEW.channels IS DISTINCT FROM OLD.channels
           OR NEW.start_date IS DISTINCT FROM OLD.start_date
           OR NEW.end_date IS DISTINCT FROM OLD.end_date
           OR NEW.budget_rial IS DISTINCT FROM OLD.budget_rial
           OR NEW.spend_rial IS DISTINCT FROM OLD.spend_rial
           OR NEW.impressions IS DISTINCT FROM OLD.impressions
           OR NEW.clicks IS DISTINCT FROM OLD.clicks
           OR NEW.leads_generated IS DISTINCT FROM OLD.leads_generated
           OR NEW.conversions IS DISTINCT FROM OLD.conversions
           OR NEW.revenue_rial IS DISTINCT FROM OLD.revenue_rial
           OR NEW.metrics_source IS DISTINCT FROM OLD.metrics_source THEN
            RAISE EXCEPTION 'a % campaign is closed; its figures were already reported', OLD.status
                USING ERRCODE = '23514';
        END IF;

        -- The client is split out of the freeze above, born that way rather than
        -- patched into it by 0279 the way 0274 and 0276 were. A closed campaign's
        -- figures are what the client was reported and stay immutable always; whose
        -- file it lives on is a different statement, and `mergeCustomers` has to be
        -- able to make it. Without the split, one completed campaign on a duplicate
        -- client record would refuse the merge outright — the bug 0279 exists to
        -- fix, and a new table has no business shipping with it.
        IF NEW.party_id IS DISTINCT FROM OLD.party_id
           AND current_setting('app.ledger_party_move', true) IS DISTINCT FROM 'on' THEN
            RAISE EXCEPTION 'client attribution moves only through an audited party merge'
                USING ERRCODE = '23514';
        END IF;

        v_cascade := OLD.brief_id IS NOT NULL AND NEW.brief_id IS NULL
                     AND NOT EXISTS (SELECT 1 FROM agency_client_briefs WHERE id = OLD.brief_id);
        IF NEW.brief_id IS DISTINCT FROM OLD.brief_id AND NOT v_cascade THEN
            RAISE EXCEPTION 'a % campaign is closed; its figures were already reported', OLD.status
                USING ERRCODE = '23514';
        END IF;

        v_cascade := OLD.proposal_id IS NOT NULL AND NEW.proposal_id IS NULL
                     AND NOT EXISTS (SELECT 1 FROM agency_proposals WHERE id = OLD.proposal_id);
        IF NEW.proposal_id IS DISTINCT FROM OLD.proposal_id AND NOT v_cascade THEN
            RAISE EXCEPTION 'a % campaign is closed; its figures were already reported', OLD.status
                USING ERRCODE = '23514';
        END IF;

        v_cascade := OLD.deal_id IS NOT NULL AND NEW.deal_id IS NULL
                     AND NOT EXISTS (SELECT 1 FROM crm_deals WHERE id = OLD.deal_id);
        IF NEW.deal_id IS DISTINCT FROM OLD.deal_id AND NOT v_cascade THEN
            RAISE EXCEPTION 'a % campaign is closed; its figures were already reported', OLD.status
                USING ERRCODE = '23514';
        END IF;

        v_cascade := OLD.project_id IS NOT NULL AND NEW.project_id IS NULL
                     AND NOT EXISTS (SELECT 1 FROM ai_projects WHERE id = OLD.project_id);
        IF NEW.project_id IS DISTINCT FROM OLD.project_id AND NOT v_cascade THEN
            RAISE EXCEPTION 'a % campaign is closed; its figures were already reported', OLD.status
                USING ERRCODE = '23514';
        END IF;

        v_cascade := OLD.contract_id IS NOT NULL AND NEW.contract_id IS NULL
                     AND NOT EXISTS (SELECT 1 FROM workspace_contracts WHERE id = OLD.contract_id);
        IF NEW.contract_id IS DISTINCT FROM OLD.contract_id AND NOT v_cascade THEN
            RAISE EXCEPTION 'a % campaign is closed; its figures were already reported', OLD.status
                USING ERRCODE = '23514';
        END IF;
        -- `note`, `metrics_note`, `owner_name` and `deal_id` stay editable, exactly
        -- as 0274 keeps a confirmed brief's note editable: what a member learned
        -- after the fact belongs on the record, and freezing it would push it into
        -- a comment thread where nobody searching the file will find it.
    END IF;

    -- A stamp that was set cannot be cleared, so a campaign cannot lose the record
    -- of when it started or stopped.
    IF OLD.status <> 'planned' AND NEW.status = 'planned' THEN
        RAISE EXCEPTION 'a campaign that has left planning cannot go back to planned'
            USING ERRCODE = '23514';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- This trigger's name sorts before `trg_agency_client_campaigns_references`, and
-- Postgres fires same-timing row triggers alphabetically, so on an UPDATE the
-- lifecycle check runs before the ownership check. That is the better order — a
-- member editing a completed campaign and pointing it at another client's brief
-- is told the campaign is closed, which is the thing to fix first — but note that
-- 0276's decision 48 is right that alphabetical order is not a contract anybody
-- should *rely* on. It is safe to rely on here only because both orders refuse:
-- the two triggers disagree about which message you get, never about whether you
-- get one. On INSERT only the references trigger fires.
CREATE TRIGGER trg_agency_client_campaigns_guard
    BEFORE UPDATE OR DELETE ON agency_client_campaigns
    FOR EACH ROW
    EXECUTE FUNCTION agency_client_campaign_guard();
