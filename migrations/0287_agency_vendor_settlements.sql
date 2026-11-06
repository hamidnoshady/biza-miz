-- Issue #1128 §D — the vendor payable's settlement: the act that debits 2140.
--
-- ## The hole this closes
--
-- 0280 gave the agency's reimbursable-cost register a third settlement, `payable`,
-- which credits **2140** «حساب‌های پرداختنی رسانه، چاپ و تولید». `account-classification.ts`
-- classifies the 214 block as a trade payable, and 0280's own comment called it "the
-- seam §D's vendor chain will use". Eight waves later the seam is still one-way: a
-- search of the whole tree finds 2140 credited in exactly one place and **debited in
-- none**. An agency that records its media buys as payable is therefore accumulating a
-- liability the product cannot clear — not a missing feature, but an unclosed loop in a
-- shipped one. §D names the missing step: "payable → **settlement** through existing
-- Accounting posting/domain-event engine, never direct ad hoc journal entries".
--
-- ## Why this is not the A/P subledger
--
-- The platform's payables engine could not simply be pointed at 2140. `ap-service.ts`
-- resolves its control account from `WELL_KNOWN_CODES.accountsPayable` (2100) in seven
-- places — every balance read, the statement, the aging, the payment and its reversal —
-- and `ap_payments.supplier_id` is `NOT NULL REFERENCES suppliers(id)`, a location-scoped
-- goods-supplier entity an agency has no use for and no screen to create. Threading a
-- second control account through that engine would fork a universal service for one
-- trade, which is what #1128 means by *adapt* #799's pattern rather than copy it. So the
-- settlement is the agency's own document, posting through the same engine the register
-- already uses.
--
-- ## Whether a cost is settled is READ, not stored
--
-- Same decision as 0284's recharge, for the same reason. There is no `status` column and
-- no `settled_at` on the cost. The row carries `settlement_id` — the payment that cleared
-- it — and the flag members see is derived:
--
--     settled  =  settlement_id IS NOT NULL
--                 AND that settlement's reversed_at IS NULL
--
-- Reversing a settlement writes a reversing entry and stamps the document; it does not go
-- back and edit a column on every cost it touched. A stored boolean would be a second
-- answer to a question the ledger already answers, and the two would disagree the first
-- time somebody reversed a payment.
--
-- ## One payment per cost, in full
--
-- `settlement_id` is a single column and there is deliberately no `settled_rial`: a cost
-- is settled in full or not at all, exactly as 0284 made it recharged in full or not at
-- all. Partial settlement would need a remaining-balance figure on the row, and a balance
-- stored beside the ledger is the same second answer again — the entry is the record of
-- what was paid.
--
-- ## Only a payable can be settled
--
-- A cost settled `cash` or `bank` credited 1100 or 1120 and never touched 2140, so
-- debiting 2140 for it would drive the account below zero and report a *negative* amount
-- owed to vendors. That is the identical error 0280 existed to prevent on the 1270 side —
-- crediting an asset nothing had debited — and it is refused here in two places: a
-- declarative CHECK that survives any rewrite of the trigger, and a trigger rule that
-- answers in words.
--
-- Additive only. No backfill: existing costs keep their `vendor_name` text and simply have
-- no settlement, and `ON DELETE SET NULL` means deleting a settlement document cannot
-- leave a cost pointing at a payment that is gone.

/* ------------------------------------------------------------------------- */
/* The settlement document                                                    */
/* ------------------------------------------------------------------------- */

CREATE TABLE agency_vendor_settlements (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

    -- The branch whose cash or bank account paid. Deletion is restricted:
    -- a posted payment retains its accounting location.
    location_id  uuid REFERENCES locations(id) ON DELETE RESTRICT,

    -- `VS-` from the shared register numbering, per business. A payment a vendor
    -- is going to be asked about needs a number somebody can quote, for the same
    -- reason a cost, a brief and a proposal have one.
    settlement_number text NOT NULL
        CONSTRAINT agency_vendor_settlements_number_check
            CHECK (char_length(btrim(settlement_number)) BETWEEN 1 AND 24),

    -- Who was paid. Free text, and deliberately so: this is 0280's limit carried
    -- forward rather than a new one. A platform, a print shop and a venue permit
    -- are often not in any supplier list, and requiring a party here would push
    -- the member to invent one or to leave the payee blank — the two failures
    -- 0280's `vendor_name` comment names. The value is copied from the costs it
    -- settles, which the service requires to agree, so the payment and the rows
    -- it cleared cannot name two different vendors. A real supplier link arrives
    -- with the quote → purchase half of the chain, which would reshape it; adding
    -- one now would be designing the link for a document that does not exist yet.
    vendor_name  text NOT NULL
        CONSTRAINT agency_vendor_settlements_vendor_name_check
            CHECK (char_length(btrim(vendor_name)) BETWEEN 1 AND 200),

    -- The debit side of the entry is always 2140; this chooses the credit, and it
    -- is the same two-way choice the register's own settlement makes, so a payment
    -- cannot introduce a third account the cost side does not know.
    method       text NOT NULL
        CONSTRAINT agency_vendor_settlements_method_check
            CHECK (method IN ('cash', 'bank')),

    amount_rial  bigint NOT NULL
        CONSTRAINT agency_vendor_settlements_amount_check CHECK (amount_rial > 0),

    -- The day the money left, not the day it was recorded: the entry is dated from
    -- this, exactly as 0280 dates a cost from `spent_on`.
    paid_on      date NOT NULL,

    note         text NOT NULL DEFAULT ''
        CONSTRAINT agency_vendor_settlements_note_check
            CHECK (char_length(note) <= 2000),

    -- Real, deletion-restricting FKs: removing a posted entry must not make
    -- its immutable source document appear unposted again.
    entry_id          uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,

    -- Reversal, not deletion: the entry is the record that money moved, so undoing
    -- it writes a reversing entry and stamps the document. `reversed_at` is what the
    -- costs' derived `settled` flag reads.
    reversed_at       timestamptz,
    reversal_entry_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,

    created_by      uuid,
    created_by_name text NOT NULL DEFAULT ''
        CONSTRAINT agency_vendor_settlements_created_by_name_check
            CHECK (char_length(created_by_name) <= 200),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT agency_vendor_settlements_number_key UNIQUE (business_id, settlement_number),
    -- A reversal without the reversing entry would claim the payment was undone
    -- while the ledger still says the money went out; an entry without the stamp
    -- would leave the costs' derived flag saying "settled" over a reversal that
    -- already put the money back into 2140.
    CONSTRAINT agency_vendor_settlements_reversal_pair_check
        CHECK ((reversed_at IS NULL) = (reversal_entry_id IS NULL))
);

CREATE INDEX idx_agency_vendor_settlements_business
    ON agency_vendor_settlements (business_id, created_at DESC);
-- The open-payables read: what this agency has paid and not reversed.
CREATE INDEX idx_agency_vendor_settlements_unreversed
    ON agency_vendor_settlements (business_id)
    WHERE reversed_at IS NULL;

ALTER TABLE agency_vendor_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_vendor_settlements FORCE ROW LEVEL SECURITY;

-- RLS shape 1, the same one 0280 and 0284 use.
CREATE POLICY tenant_isolation ON agency_vendor_settlements FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE agency_vendor_settlements IS
    'Issue #1128 §D: the payment that clears an agency''s vendor payable. Debits 2140 and credits 1100 or 1120 through the existing posting engine — the debit side of an account 0280 only ever credited. Whether a cost counts as settled is DERIVED from settlement_id and this table''s reversed_at, never stored on the cost.';

/* ------------------------------------------------------------------------- */
/* The settlement's own guard                                                 */
/* ------------------------------------------------------------------------- */

-- Frozen once posted, for the reason 0280 freezes a cost: the books carry the
-- figure, so editing the document would leave the entry describing a payment
-- nobody made. `note` stays open, and so do the two reversal columns, because
-- those are written back by the system performing the reversal.
CREATE OR REPLACE FUNCTION agency_vendor_settlement_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.entry_id IS NOT NULL THEN
            RAISE EXCEPTION 'a posted vendor settlement cannot be deleted; reverse it instead'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    -- A reversal happens once, and once it has happened *neither* column moves.
    -- Gating on `reversed_at` changing alone is not enough, and the guard harness
    -- caught this: swapping `reversal_entry_id` on an already-reversed settlement
    -- leaves the document naming a reversal that is not the one which put the money
    -- back into 2140, so the record and the ledger would describe two different
    -- acts. Clearing the stamp is refused separately and in its own words, because
    -- it would make every cost's derived flag say "settled" again over an entry
    -- that is still reversed.
    IF OLD.reversed_at IS NOT NULL THEN
        IF NEW.reversed_at IS NULL THEN
            RAISE EXCEPTION 'a reversed settlement stays reversed; record a new payment'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.reversed_at          IS DISTINCT FROM OLD.reversed_at
           OR NEW.reversal_entry_id IS DISTINCT FROM OLD.reversal_entry_id THEN
            RAISE EXCEPTION 'this settlement is already reversed'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.reversed_at IS NOT NULL AND NEW.reversal_entry_id IS NULL THEN
        RAISE EXCEPTION 'a reversal needs the reversing entry that puts the money back'
            USING ERRCODE = '23514';
    END IF;

    -- Not posted yet: editable, and the engine writes `entry_id` back in the same
    -- transaction, which must not be refused.
    IF OLD.entry_id IS NULL THEN
        NEW.updated_at := now();
        RETURN NEW;
    END IF;

    IF NEW.amount_rial  IS DISTINCT FROM OLD.amount_rial
       OR NEW.method     IS DISTINCT FROM OLD.method
       OR NEW.vendor_name IS DISTINCT FROM OLD.vendor_name
       OR NEW.paid_on    IS DISTINCT FROM OLD.paid_on THEN
        RAISE EXCEPTION 'a posted vendor settlement is frozen; reverse it and record a new one'
            USING ERRCODE = '23514';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- Named so the intended order holds: Postgres fires same-timing row triggers
-- alphabetically, which is an implementation detail and not a contract, so the
-- guard runs before the reference check.
CREATE TRIGGER trg_agency_vendor_settlements_guard
    BEFORE UPDATE OR DELETE ON agency_vendor_settlements
    FOR EACH ROW EXECUTE FUNCTION agency_vendor_settlement_guard();

/* ------------------------------------------------------------------------- */
/* The cost side: which payment cleared it                                    */
/* ------------------------------------------------------------------------- */

ALTER TABLE agency_reimbursable_costs
    ADD COLUMN settlement_id uuid REFERENCES agency_vendor_settlements(id) ON DELETE SET NULL;

-- Only a cost that credited 2140 can be settled out of it. Declarative, so the
-- rule survives any rewrite of the trigger below; the trigger states it in words.
ALTER TABLE agency_reimbursable_costs
    ADD CONSTRAINT agency_reimbursable_costs_settlement_payable_only
        CHECK (settlement_id IS NULL OR settled_by = 'payable');

-- The open-payable queue: costs that credited 2140 and no payment has cleared.
CREATE INDEX idx_agency_reimbursable_costs_unsettled
    ON agency_reimbursable_costs (business_id, party_id)
    WHERE settlement_id IS NULL AND settled_by = 'payable';

COMMENT ON COLUMN agency_reimbursable_costs.settlement_id IS
    'Issue #1128 §D: the vendor payment that cleared this cost out of 2140. Whether the cost counts as settled is DERIVED — this column is not null AND that settlement''s reversed_at is null — because reversing a payment writes a reversing entry and stamps the document rather than editing rows, so a stored flag would be a second answer that disagrees with the ledger.';

/* ------------------------------------------------------------------------- */
/* The register's guard, restated in full                                     */
/* ------------------------------------------------------------------------- */

-- `CREATE OR REPLACE FUNCTION` replaces the whole body, so every rule 0280 and
-- 0284 established is restated here rather than inherited: a rule dropped from
-- this copy would be dropped from the database.
CREATE OR REPLACE FUNCTION agency_reimbursable_cost_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_order_status text;
    v_live         boolean;
    v_settlement   uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.entry_id IS NOT NULL THEN
            RAISE EXCEPTION 'a posted reimbursable cost cannot be deleted; reverse the entry instead'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    -- ---------------------------------------------------------------------
    -- 0284's recharge link, unchanged and still checked before the substance
    -- freeze: writing it is an UPDATE of a row that is always already posted,
    -- so the freeze would otherwise refuse the recharge itself.
    -- ---------------------------------------------------------------------
    IF NEW.recharged_order_id IS DISTINCT FROM OLD.recharged_order_id THEN
        v_live := false;
        IF OLD.recharged_order_id IS NOT NULL THEN
            SELECT (o.status IS DISTINCT FROM 'voided') INTO v_live
              FROM orders o
             WHERE o.id = OLD.recharged_order_id;
            -- A missing order is not live either: the FK's own ON DELETE SET NULL
            -- means the invoice is gone, and with it the reason to protect the link.
            v_live := coalesce(v_live, false);
        END IF;

        IF v_live THEN
            IF NEW.recharged_order_id IS NULL THEN
                RAISE EXCEPTION 'a recharge is undone by voiding the invoice that made it, not by clearing the link'
                    USING ERRCODE = '23514';
            END IF;
            RAISE EXCEPTION 'this cost is already recharged by another invoice; void that invoice first'
                USING ERRCODE = '23514';
        END IF;

        IF NEW.recharged_order_id IS NOT NULL THEN
            SELECT o.status INTO v_order_status
              FROM orders o
              JOIN locations l ON l.id = o.location_id AND l.business_id = NEW.business_id
             WHERE o.id = NEW.recharged_order_id;
            IF v_order_status IS NULL THEN
                RAISE EXCEPTION 'invoice % does not belong to this business', NEW.recharged_order_id
                    USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;

    -- ---------------------------------------------------------------------
    -- The settlement link, the same shape and for the same reason: a cost is
    -- settled only after it has posted, so this is always an UPDATE of a frozen
    -- row and belongs before the freeze. Re-pointing or clearing is refused
    -- while the payment it points at still stands, because the money is out of
    -- 2140 and either act would let the same media buy be paid a second time.
    -- Undoing a settlement is reversing it; only then is the cost free again.
    -- ---------------------------------------------------------------------
    IF NEW.settlement_id IS DISTINCT FROM OLD.settlement_id THEN
        v_live := false;
        IF OLD.settlement_id IS NOT NULL THEN
            SELECT (s.reversed_at IS NULL) INTO v_live
              FROM agency_vendor_settlements s
             WHERE s.id = OLD.settlement_id;
            v_live := coalesce(v_live, false);
        END IF;

        IF v_live THEN
            IF NEW.settlement_id IS NULL THEN
                RAISE EXCEPTION 'a settlement is undone by reversing the payment, not by clearing the link'
                    USING ERRCODE = '23514';
            END IF;
            RAISE EXCEPTION 'this cost is already settled by another payment; reverse that payment first'
                USING ERRCODE = '23514';
        END IF;

        IF NEW.settlement_id IS NOT NULL THEN
            -- Tenancy, read through the document itself rather than trusted.
            SELECT s.id INTO v_settlement
              FROM agency_vendor_settlements s
             WHERE s.id = NEW.settlement_id AND s.business_id = NEW.business_id;
            IF v_settlement IS NULL THEN
                RAISE EXCEPTION 'settlement % does not belong to this business', NEW.settlement_id
                    USING ERRCODE = '23514';
            END IF;

            -- Settling a cost that never credited 2140 would drive the account
            -- below zero and report a negative amount owed to vendors.
            IF NEW.settled_by <> 'payable' THEN
                RAISE EXCEPTION 'only a cost recorded as payable can be settled out of 2140'
                    USING ERRCODE = '23514';
            END IF;

            -- And nothing may be paid out of an account before the entry that put
            -- it there has landed — the same refusal the recharge makes.
            IF OLD.entry_id IS NULL THEN
                RAISE EXCEPTION 'a cost that has not posted cannot be settled'
                    USING ERRCODE = '23514';
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM agency_vendor_settlements s
                 WHERE s.id=NEW.settlement_id AND s.business_id=NEW.business_id
                   AND s.entry_id IS NOT NULL AND s.reversed_at IS NULL
            ) THEN
                RAISE EXCEPTION 'a cost needs a posted unreversed settlement'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;

    -- ---------------------------------------------------------------------
    -- 0280's substance freeze, unchanged. `note` stays open, and so do the
    -- recharge- and settlement-attribution columns, because they record an act
    -- performed on the row rather than anything the posted entry was built from.
    -- ---------------------------------------------------------------------
    IF OLD.entry_id IS NULL THEN
        NEW.updated_at := now();
        RETURN NEW;
    END IF;

    IF NEW.amount_rial     IS DISTINCT FROM OLD.amount_rial
       OR NEW.presentation IS DISTINCT FROM OLD.presentation
       OR NEW.settled_by   IS DISTINCT FROM OLD.settled_by
       OR NEW.project_id   IS DISTINCT FROM OLD.project_id
       OR NEW.spent_on     IS DISTINCT FROM OLD.spent_on
       OR NEW.description  IS DISTINCT FROM OLD.description
       OR NEW.vendor_name  IS DISTINCT FROM OLD.vendor_name THEN
        RAISE EXCEPTION 'a posted reimbursable cost is frozen; reverse the entry and record a new one'
            USING ERRCODE = '23514';
    END IF;

    -- 0279's door, restated: the client attribution moves only through an audited
    -- party merge.
    IF NEW.party_id IS DISTINCT FROM OLD.party_id
       AND current_setting('app.ledger_party_move', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'client attribution moves only through an audited party merge'
            USING ERRCODE = '23514';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- Reference integrity is enforced even for callers bypassing the service and RLS.
CREATE FUNCTION agency_vendor_settlement_references() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.business_id IS DISTINCT FROM OLD.business_id
           OR NEW.settlement_number IS DISTINCT FROM OLD.settlement_number THEN
            RAISE EXCEPTION 'settlement identity is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.entry_id IS NOT NULL AND
           (NEW.entry_id IS DISTINCT FROM OLD.entry_id
            OR NEW.location_id IS DISTINCT FROM OLD.location_id) THEN
            RAISE EXCEPTION 'posted settlement references are immutable' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.location_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM locations WHERE id=NEW.location_id AND business_id=NEW.business_id
    ) THEN
        RAISE EXCEPTION 'settlement location belongs to another business' USING ERRCODE = '23514';
    END IF;
    IF NEW.entry_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM journal_entries WHERE id=NEW.entry_id AND business_id=NEW.business_id
    ) THEN
        RAISE EXCEPTION 'settlement entry belongs to another business' USING ERRCODE = '23514';
    END IF;
    IF NEW.reversal_entry_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM journal_entries WHERE id=NEW.reversal_entry_id AND business_id=NEW.business_id
    ) THEN
        RAISE EXCEPTION 'settlement reversal belongs to another business' USING ERRCODE = '23514';
    END IF;
    IF NEW.reversed_at IS NOT NULL AND NEW.entry_id IS NULL THEN
        RAISE EXCEPTION 'an unposted settlement cannot be reversed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_agency_vendor_settlements_references
    BEFORE INSERT OR UPDATE ON agency_vendor_settlements
    FOR EACH ROW EXECUTE FUNCTION agency_vendor_settlement_references();

-- A new cost cannot arrive already paid by a different document: create/post it
-- first, then attach the payment under the UPDATE guard above.
CREATE FUNCTION agency_cost_settlement_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.settlement_id IS NOT NULL THEN
        RAISE EXCEPTION 'record the cost before settling it' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_agency_cost_settlement_insert
    BEFORE INSERT ON agency_reimbursable_costs
    FOR EACH ROW EXECUTE FUNCTION agency_cost_settlement_insert_guard();
