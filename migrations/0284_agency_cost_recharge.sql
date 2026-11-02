-- ============================================================================
-- 0284_agency_cost_recharge.sql — the half that turns account 1270 from an
-- accumulator into a clearing account.
--
-- 0280 opened the door to 1270 from the cost side: money an agency spends on a
-- client's behalf debits it, so the balance is the true statement "we have spent
-- this on clients and not yet asked them for it". Nothing could credit it, because
-- the recharge did not exist. This migration adds the column that records it, and
-- `agency-recharge.ts` / the pass-through invoice line do the crediting.
--
-- ## Whether a cost has been recharged is READ, not stored
--
-- There is deliberately no `status` column and no `recharged_at` here. The row
-- carries `recharged_order_id` — the invoice that asked the client for the money —
-- and *whether that counts* is derived by looking at the order:
--
--     recharged  =  recharged_order_id IS NOT NULL
--                   AND the order's status IS DISTINCT FROM 'voided'
--
-- `retail-invoice-void-service.ts` does not delete an invoice; it flips
-- `orders.status` to `'voided'` and writes a reversing entry, leaving the original
-- in place. So a voided recharge already puts the money back into 1270 through the
-- ledger, and deriving the flag from the order's live status means the cost becomes
-- rechargeable again **with no hook, no stored state and nothing to fall out of
-- step**. A stored `recharged` boolean would be a second answer to a question the
-- order already answers, and the two would disagree the first time somebody voided
-- an invoice — which is exactly the "stored cost is a staler answer" rule
-- `agency-commercial-service.ts` applies to §D's cost side.
--
-- ## Double-billing is the failure this guards against
--
-- The one thing that must not happen is charging a client twice for the same media
-- buy: 1270 would clear past zero and the agency's revenue would be overstated by
-- an amount nobody spent. So the trigger below refuses to re-point
-- `recharged_order_id` at a different invoice, and refuses to clear it, *while the
-- invoice it already points at is still live*. Undoing a recharge is done by voiding
-- that invoice, which reverses the entry and puts the money back into 1270; only then
-- is the cost free to be billed again, and then both re-pointing and clearing are
-- legitimate, because both are tidying up after an act that already reversed the
-- money. The rule is about the invoice's state and not about which column changed.
--
-- ## Whole or nothing
--
-- A cost is recharged in full or not at all: one invoice line per cost row, and no
-- `recharged_rial` column. Partial recharge would need a remaining-balance figure
-- that has to agree with both the register and 1270's ledger balance, and two
-- sources for one number is how they come apart. Media buys are billed whole in
-- practice; if a genuinely partial recharge is ever needed it is two cost rows, not
-- one row billed twice.
--
-- Additive: two columns, one index, and a redefinition of 0280's guard function in
-- the same audited-door style 0279 established. Nothing existing is altered, no data
-- is backfilled, and 0280 is not edited in place.
-- ============================================================================

ALTER TABLE agency_reimbursable_costs
    -- The invoice that asked the client for this money back. `SET NULL` because a
    -- deleted order cannot be the reason a cost is still marked recharged, and
    -- because the derived flag treats a missing order as "not recharged" — the safe
    -- direction, since it makes a cost rechargeable again rather than silently
    -- writing off a claim on the client.
    ADD COLUMN recharged_order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
    -- Who recharged it, for the same reason 0280 records `created_by`: the act of
    -- asking a client for money is attributable, and a bare uuid keeps this register
    -- out of the whole-schema member-history contract.
    ADD COLUMN recharged_by uuid,
    ADD COLUMN recharged_by_name text NOT NULL DEFAULT ''
        CONSTRAINT agency_reimbursable_costs_recharged_by_name_check
            CHECK (char_length(recharged_by_name) <= 200);

COMMENT ON COLUMN agency_reimbursable_costs.recharged_order_id IS
    'Issue #1128 §D: the invoice that recharged this cost to the client. Whether the cost counts as recharged is DERIVED — this column is not null AND the order''s status is distinct from ''voided'' — because retail-invoice-void-service flips the order to voided and writes a reversing entry rather than deleting anything, so the ledger already puts the money back into 1270 and a stored flag would only disagree with it.';

-- The outstanding claim per client, which is the question §D's receivables view asks:
-- costs with no live invoice behind them. Partial, so it stays small as recharges
-- accumulate, and it is what makes "what is this client owed back" a read.
CREATE INDEX idx_agency_reimbursable_costs_unrecharged
    ON agency_reimbursable_costs (business_id, party_id, spent_on)
    WHERE recharged_order_id IS NULL;

-- ---------------------------------------------------------------------------
-- A cost is recharged by exactly one live invoice
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agency_reimbursable_cost_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_order_status text;
    v_live         boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.entry_id IS NOT NULL THEN
            RAISE EXCEPTION 'a posted reimbursable cost cannot be deleted; reverse the entry instead'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    -- ---------------------------------------------------------------------
    -- The recharge link, checked before the substance freeze: writing it is an
    -- UPDATE of a row that is always already posted (0280 posts in the same
    -- transaction it creates in), so the freeze below would otherwise refuse the
    -- recharge itself. This is the same exemption shape 0280 gives `entry_id` —
    -- the columns the *system* writes back are not the columns a member edits.
    -- ---------------------------------------------------------------------
    IF NEW.recharged_order_id IS DISTINCT FROM OLD.recharged_order_id THEN
        -- Is the invoice this cost *already* points at still asking the client for
        -- money? `orders` carries no business_id, so tenancy is reached through its
        -- location; the status itself is read without a tenant filter on purpose,
        -- because this is a question about a row the FK already proved exists, and
        -- scoping it would let a cross-tenant order read as "missing" and therefore as
        -- already voided.
        v_live := false;
        IF OLD.recharged_order_id IS NOT NULL THEN
            SELECT (o.status IS DISTINCT FROM 'voided') INTO v_live
              FROM orders o
             WHERE o.id = OLD.recharged_order_id;
            -- A missing order is not live either: the FK's own ON DELETE SET NULL
            -- means the invoice is gone, and with it the reason to protect the link.
            v_live := coalesce(v_live, false);
        END IF;

        -- Both re-pointing and clearing are refused while that invoice is live, and
        -- for one reason: the money is out of 1270 and the client has been asked, so
        -- either act would let the same media buy be billed a second time. Undoing a
        -- recharge is done by voiding the invoice, which reverses the entry; only then
        -- is the cost free to be billed again, and then *both* acts are legitimate.
        IF v_live THEN
            IF NEW.recharged_order_id IS NULL THEN
                RAISE EXCEPTION 'a recharge is undone by voiding the invoice that made it, not by clearing the link'
                    USING ERRCODE = '23514';
            END IF;
            RAISE EXCEPTION 'this cost is already recharged by another invoice; void that invoice first'
                USING ERRCODE = '23514';
        END IF;

        -- Whatever the link becomes, the invoice it points at must be this tenant's.
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
    -- 0280's substance freeze, unchanged: a row the ledger carries may not be
    -- edited into disagreeing with it. `note` stays open, and so do the two
    -- recharge-attribution columns, because they record the act of asking rather
    -- than anything the posted entry was built from.
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

    -- The client attribution still moves only through an audited party merge
    -- (0279's door). Re-stated here rather than inherited: `CREATE OR REPLACE`
    -- replaces the whole function body, so a rule dropped from this copy would be
    -- dropped from the database.
    IF NEW.party_id IS DISTINCT FROM OLD.party_id
       AND current_setting('app.ledger_party_move', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'client attribution moves only through an audited party merge'
            USING ERRCODE = '23514';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
