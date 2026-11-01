-- ============================================================================
-- 0280_agency_reimbursable_costs.sql — money an agency spends on a client's
-- behalf, and the first door that reaches account 1270.
--
-- ## Why this table exists before the invoice that recharges it
--
-- §D asks for "pass-through / reimbursable client costs versus agency-owned
-- expenses", with "gross vs net revenue presentation … follow[ing] chosen
-- business accounting policy" and "must not be inferred solely from spend". Wave
-- 1 seeded the account that makes that a ledger fact rather than a note in a
-- spreadsheet:
--
--     1270  هزینه‌های قابل بازدریافت از مشتری (رسانه و تولید)   asset
--
-- and `account-classification.ts` deliberately leaves it unclassified, because it
-- is an *unbilled* pass-through and not an invoice the client owes yet — putting
-- it in the A/R totals or in `ASSET_SALE_PROCEEDS_ROLES` would misstate both.
--
-- **Eight waves later nothing posts to it.** That is not an oversight in the
-- chart; it is that 1270 has no door:
--
--   * the expense path cannot reach it. `expense-accounts.ts` returns
--     `accounts.filter((account) => account.type === "expense")`, and 1270 is an
--     asset. Its own docblock says why the rule is that strict — a rent payment
--     could once be credited against inventory or recoverable VAT — and the
--     strictness is correct, so widening it to let an expense debit an asset
--     would undo a real fix;
--   * §D forbids the obvious workaround: the vendor chain must run "through
--     existing Accounting posting/domain-event engine, **never direct ad hoc
--     journal entries**";
--   * and the recharge side — an invoice line crediting 1270 — cannot come
--     first, because crediting an asset nothing ever debited would drive it to a
--     credit balance and report a *negative* claim on the client.
--
-- So the cost side is the half that has to exist first, and on its own it leaves
-- the books **correct but incomplete** rather than wrong: a debit balance in 1270
-- is exactly the true statement "we have spent this on clients and not yet
-- recharged it". The recharge is the next wave, and it will clear this account
-- row by row.
--
-- ## Gross and net are one explicit choice, recorded per document
--
-- `presentation` is `net` or `gross`, and the posting rule branches on it:
--
--     net    Debit  1270  هزینه‌های قابل بازدریافت از مشتری
--     gross  Debit  5197  هزینهٔ رسانه
--     both   Credit 1100 / 1120 / 2140  by how it was settled
--
-- This is what §D's "must not be inferred solely from spend" means in practice.
-- Two agencies that both buy a client ۵٬۰۰۰٬۰۰۰ ریال of media make *different*
-- accounting statements about it, and nothing in the spend says which: one is
-- reselling media and recognises the whole recharge as its own revenue with the
-- buy as cost of sales, the other is handling the client's money and never owns
-- either side. Guessing from the size of the line, or from whether a vendor
-- invoice exists, is exactly the inference §D rules out — so the choice is a
-- field a member sets, is stored on the document, and is carried into the entry.
--
-- `net` is the default because it is the treatment that keeps the agency's own
-- revenue honest: an unchosen line that lands in 5197 overstates both cost of
-- sales and, at recharge, revenue, and the pair of errors is harder to see than
-- one. A business whose policy is gross sets it per document until the
-- business-level default §D asks for arrives, and the field is where that default
-- will land.
--
-- ## What this is not
--
-- It is not the vendor quote → approved purchase → payable → settlement chain.
-- That is §D's supplier side, it is procurement's shape (quotes, approvals, a
-- three-way match, settlement against a PO), and building it here would mean two
-- ways to book the same media buy. This register records the **cost as a claim on
-- a client**, which is the fact the chain does not carry: a purchase order knows
-- what was bought and what is owed to whom, and not that the client is the one
-- who will pay for it. `settled_by = 'payable'` is the seam — it credits 2140,
-- the trade payable `account-classification.ts` already classifies, so the day the
-- chain exists it settles *this* row rather than duplicating it.
--
-- Additive: one table, two triggers, indexes, RLS. Nothing existing is altered,
-- no data is backfilled, and nothing here posts except through the engine.
-- ============================================================================

CREATE TABLE agency_reimbursable_costs (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

    -- `RC-` from the shared register numbering, per business. A media buy the
    -- client is going to be asked about needs a number somebody can quote over
    -- the phone, for the same reason a brief and a proposal have one.
    cost_number      text NOT NULL
                     CONSTRAINT agency_reimbursable_costs_cost_number_check
                         CHECK (char_length(btrim(cost_number)) BETWEEN 1 AND 24),

    -- The client who will be asked to pay this back. NOT NULL and `CASCADE`: a
    -- reimbursable cost with no client is an ordinary expense, and the expense
    -- screen already books those — this table exists precisely to hold the ones
    -- that are somebody else's. Deleting the client takes the record with it,
    -- because the claim dies with the party it was a claim on.
    party_id         uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,

    -- The project the spend belongs to, so §D's project P&L reads it from the
    -- ledger rather than assembling it from documents. `SET NULL` rather than
    -- `CASCADE`: a project being archived does not un-spend money the client
    -- still owes, and the client dimension alone is enough to recharge it.
    project_id       uuid REFERENCES ai_projects(id) ON DELETE SET NULL,

    -- Who the agency paid. Not a `parties` FK, and that is a deliberate limit
    -- rather than an omission: a platform, a print shop and a venue permit are
    -- often not in the agency's own supplier list, and requiring one would push
    -- the member to invent a party or to leave the field empty. The vendor chain
    -- is where a real supplier link arrives.
    vendor_name      text NOT NULL DEFAULT ''
                     CONSTRAINT agency_reimbursable_costs_vendor_name_check
                         CHECK (char_length(vendor_name) <= 200),

    description      text NOT NULL
                     CONSTRAINT agency_reimbursable_costs_description_check
                         CHECK (char_length(btrim(description)) BETWEEN 1 AND 300),

    -- Rial, as an integer, like every other money column in the agency
    -- registers. Positive and never zero: a zero-rial pass-through is not a
    -- claim on anybody and would sit in 1270 as a row that can never clear.
    amount_rial      bigint NOT NULL
                     CONSTRAINT agency_reimbursable_costs_amount_check
                         CHECK (amount_rial > 0),

    -- The day the money was spent, which is the day the entry is dated. Kept
    -- apart from `created_at` because a member records a platform invoice days
    -- after the platform charged the card, and the cost belongs to the day it
    -- was incurred — the same distinction `businessToday` exists to serve.
    spent_on         date NOT NULL,

    -- §D's gross-versus-net presentation, chosen and recorded rather than
    -- inferred. See the header: this is the field that decides whether the debit
    -- lands in 1270 or in 5197.
    presentation     text NOT NULL DEFAULT 'net'
                     CONSTRAINT agency_reimbursable_costs_presentation_check
                         CHECK (presentation IN ('net', 'gross')),

    -- How it was settled, which is the entry's credit side. `payable` credits
    -- 2140, the media/print/production trade payable, and is the default because
    -- a platform charge arrives before it is paid far more often than an agency
    -- settles it at the counter.
    settled_by       text NOT NULL DEFAULT 'payable'
                     CONSTRAINT agency_reimbursable_costs_settled_by_check
                         CHECK (settled_by IN ('cash', 'bank', 'payable')),

    note             text NOT NULL DEFAULT ''
                     CONSTRAINT agency_reimbursable_costs_note_check
                         CHECK (char_length(note) <= 4000),

    -- The journal entry the posting engine wrote for this cost, or NULL while it
    -- is still queued — a locked fiscal period routes an auto-posted entry to the
    -- human-approval queue rather than refusing the spend, so "recorded but not
    -- yet posted" is a real state and not a failure. This column *is* the freeze
    -- predicate below: once the ledger carries the figure, the register may not
    -- disagree with it.
    --
    -- A real FK with `ON DELETE SET NULL`, where 0134's `cost_posted_entry_id` on
    -- `message_campaigns` is a bare uuid. 0049's `domain_events.entry_id` is the
    -- better precedent and the reason is not tidiness: a dangling id here would
    -- report "this cost is posted and therefore frozen" about an entry that no
    -- longer exists, which is a claim about the books rather than a missing link.
    entry_id         uuid REFERENCES journal_entries(id) ON DELETE SET NULL,

    -- A bare uuid, not `REFERENCES users(id)`, following 0276 and 0278: pointing
    -- a document register at `users` enrols it in the whole-schema
    -- member-history contract, which is about what a *member* did and not about
    -- who typed a cost. `created_by_name` is the display copy, as elsewhere.
    created_by       uuid,
    created_by_name  text NOT NULL DEFAULT ''
                     CONSTRAINT agency_reimbursable_costs_created_by_name_check
                         CHECK (char_length(created_by_name) <= 200),

    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    -- One sequence per agency, so two members recording a platform charge at the
    -- same moment cannot be handed the same number.
    CONSTRAINT agency_reimbursable_costs_business_number_key
        UNIQUE (business_id, cost_number),
    -- So a later register can composite-FK a cost row without a second unique
    -- index, which is what 0276 did for proposal lines.
    CONSTRAINT agency_reimbursable_costs_business_id_key
        UNIQUE (business_id, id)
);

-- Per client, which is how the outstanding balance is asked for: 1270's debit
-- balance *is* what a client owes back, and this index is what makes that a read
-- rather than a scan.
CREATE INDEX idx_agency_reimbursable_costs_party
    ON agency_reimbursable_costs (business_id, party_id, spent_on DESC);
CREATE INDEX idx_agency_reimbursable_costs_project
    ON agency_reimbursable_costs (business_id, project_id)
    WHERE project_id IS NOT NULL;
-- The not-yet-posted rows, which is the queue a member works through.
CREATE INDEX idx_agency_reimbursable_costs_unposted
    ON agency_reimbursable_costs (business_id, created_at)
    WHERE entry_id IS NULL;

ALTER TABLE agency_reimbursable_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_reimbursable_costs FORCE ROW LEVEL SECURITY;
-- Shape 1, as every agency register uses it: enabled *and* forced, one policy,
-- bypass-aware helpers rather than a raw `current_setting` read.
CREATE POLICY tenant_isolation ON agency_reimbursable_costs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Every reference belongs to this tenant, and to this cost's own client
-- ---------------------------------------------------------------------------
-- The FK proves a uuid exists; it cannot prove it is this business's. Without
-- this, a request carrying a foreign `project_id` would tag a cost onto another
-- tenant's project and put it in that project's P&L — an IDOR that reads as a
-- reporting bug rather than as a leak.
CREATE OR REPLACE FUNCTION agency_assert_reimbursable_cost_references_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_party_owner   uuid;
    v_project_owner uuid;
BEGIN
    -- The client first, and in words: it is NOT NULL, so a foreign one is the
    -- sharper leak — it files a cost against another tenant's customer and puts
    -- it in that customer's outstanding balance.
    SELECT pa.business_id INTO v_party_owner
      FROM parties pa
     WHERE pa.id = NEW.party_id;
    IF v_party_owner IS NULL OR v_party_owner <> NEW.business_id THEN
        RAISE EXCEPTION 'client % does not belong to this business', NEW.party_id
            USING ERRCODE = '23514';
    END IF;

    IF NEW.project_id IS NOT NULL THEN
        SELECT p.business_id INTO v_project_owner
          FROM ai_projects p
         WHERE p.id = NEW.project_id;
        IF v_project_owner IS NULL OR v_project_owner <> NEW.business_id THEN
            RAISE EXCEPTION 'project % does not belong to this business', NEW.project_id
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- `party_id` is in the OF list for the same reason `project_id` is: a NOT NULL FK
-- proves the party exists, and only this trigger proves it is this tenant's.
CREATE TRIGGER trg_agency_reimbursable_costs_references
    BEFORE INSERT OR UPDATE OF party_id, project_id, business_id ON agency_reimbursable_costs
    FOR EACH ROW
    EXECUTE FUNCTION agency_assert_reimbursable_cost_references_owned();

-- ---------------------------------------------------------------------------
-- Once the ledger carries it, the register may not disagree
-- ---------------------------------------------------------------------------
-- A different freeze from the one 0274, 0276 and 0278 use, and the difference is
-- the reason it exists. Those freeze a document because a *human* relied on it —
-- a client confirmed a brief, accepted a price, was reported a campaign's
-- figures. This one freezes because the **books** carry the figure: the amount,
-- the presentation and the settlement decide which two accounts an entry landed
-- in, so editing any of them after posting would leave the register stating
-- something the ledger contradicts, and the pair would be reconcilable only by
-- reading both.
--
-- The correction is therefore a reversal and a new record, not an edit — the same
-- shape the ledger itself uses, and the reason `note` stays open while everything
-- the entry was built from does not: what a member learned afterwards belongs on
-- the row, and changing it does not desync anything.
--
-- A row that has not posted (`entry_id IS NULL`, still queued) is editable and
-- deletable, because nothing has been written yet and refusing there would strand
-- a mistake behind an approval the member cannot withdraw.
CREATE OR REPLACE FUNCTION agency_reimbursable_cost_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.entry_id IS NOT NULL THEN
            RAISE EXCEPTION 'a posted reimbursable cost cannot be deleted; reverse the entry instead'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    -- An UPDATE that arrives without a posted entry is ordinary editing. Note
    -- that `entry_id` itself is not frozen: the engine writes it back, and that
    -- write is an UPDATE of this row.
    IF OLD.entry_id IS NULL THEN
        NEW.updated_at := now();
        RETURN NEW;
    END IF;

    IF NEW.amount_rial     IS DISTINCT FROM OLD.amount_rial
       OR NEW.presentation IS DISTINCT FROM OLD.presentation
       OR NEW.settled_by   IS DISTINCT FROM OLD.settled_by
       OR NEW.party_id     IS DISTINCT FROM OLD.party_id
       OR NEW.project_id   IS DISTINCT FROM OLD.project_id
       OR NEW.spent_on     IS DISTINCT FROM OLD.spent_on
       OR NEW.description  IS DISTINCT FROM OLD.description
       OR NEW.vendor_name  IS DISTINCT FROM OLD.vendor_name THEN
        RAISE EXCEPTION 'a posted reimbursable cost is frozen; reverse the entry and record a new one'
            USING ERRCODE = '23514';
    END IF;

    -- The one exemption, and it is narrow: the entry this row points at going
    -- away (the FK's `ON DELETE SET NULL`) is an UPDATE of this row made by the
    -- database, not by a member. Refusing it would make the row undeletable from
    -- the ledger side. Allowing a member to clear `entry_id` by hand is not what
    -- this permits, because the comparison below still runs on every other
    -- column — and clearing it alone unfreezes nothing that was not already
    -- going to be re-frozen by the next posting.
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- Named like 0274's and 0278's, which means it fires *before* `..._references`
-- on an UPDATE ('g' sorts before 'r', and Postgres orders same-timing row
-- triggers by name — an implementation detail, not a contract). That order is
-- harmless here and is stated rather than left to chance: the guard reads only
-- OLD and NEW columns it does not need validated first, and a member who edits a
-- posted row *and* points it at a foreign project is told the row is frozen,
-- which is the truer of the two refusals. On INSERT only `..._references` fires,
-- so there is nothing to order.
CREATE TRIGGER trg_agency_reimbursable_costs_guard
    BEFORE UPDATE OR DELETE ON agency_reimbursable_costs
    FOR EACH ROW
    EXECUTE FUNCTION agency_reimbursable_cost_guard();
