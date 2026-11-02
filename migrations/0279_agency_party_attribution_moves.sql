-- ============================================================================
-- 0279_agency_party_attribution_moves.sql — the audited door through a frozen
-- agency document's client attribution.
--
-- ## The bug this fixes
--
-- 0274 freezes a confirmed brief and 0276 freezes a sent proposal, and both put
-- `party_id` inside the frozen-substance comparison. That is right for an edit and
-- wrong for a merge, and the two are not the same operation:
--
--   * an edit says "the client agreed to something different than we recorded",
--     which a confirmed brief must refuse — the client confirmed *that* text;
--   * a merge says "these two client records were always one", which changes no
--     agreement at all and only re-points whose file the document lives on.
--
-- `mergeCustomers` re-points every reference `party-merge-references.ts` classifies
-- as `move`, and a brief's and a proposal's client is exactly that — NOT NULL, so
-- it cannot be left behind, and stranded on an archived duplicate the record of
-- what was agreed disappears from the file a dispute would look in. The result was
-- that merging two clients failed with a raw `23514` as soon as either held a
-- confirmed brief or a sent proposal, on the CRM's own duplicates screen. The
-- merge code calls a half-applied merge the worst available outcome; this made a
-- *fully refused* one routine.
--
-- ## The fix follows 0217 rather than inventing one
--
-- `journal_immutable_columns_guard` already drew this line: financial facts are
-- immutable always, and `party_id` may move only while the transaction has declared
-- `app.ledger_party_move = on` — a flag `mergeCustomers` sets for a reference that
-- declares a `preMoveSql`, after that statement has written the audit row. So the
-- attribution move lands in an audit table FIRST, the door opens for exactly that
-- registered move, and every other session still hits the guard.
--
-- The flag's name is historical and is kept for the reason
-- `register-numbering.ts` keeps its `aec-number:` namespace: it is the string the
-- merge loop already sets, and a second flag name would mean teaching that loop
-- about two doors for one operation.
--
-- ## Why the substance is not relaxed
--
-- Only the party columns move out of the freeze. A confirmed brief's objective and
-- a sent proposal's price stay exactly as immutable as they were, and the new
-- refusal names the merge as the only door — so a member who tries to re-file a
-- confirmed brief as another client's is told what the rule is rather than getting
-- the old message, which now means something narrower than it used to.
--
-- Additive: one audit table and two function redefinitions. No data is touched, and
-- a document that was frozen stays frozen for every path except the audited merge.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The audit trail for an attribution move
-- ---------------------------------------------------------------------------
-- Deliberately not `ledger_party_attribution_moves`: that table records moves of
-- posted journal lines, and an agency document is not a journal line. Sharing it
-- would put briefs in a ledger report and make its `line_id`/`entry_id` columns
-- meaningless for most of its rows.
CREATE TABLE crm_party_attribution_moves (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Not a CHECK over a fixed list: this is an audit log, and widening it to
    -- cover a fourth agency register should be a line in the registry rather than
    -- a migration.
    table_name    text NOT NULL CHECK (char_length(btrim(table_name)) BETWEEN 1 AND 63),
    row_id        uuid NOT NULL,
    old_party_id  uuid NOT NULL,
    new_party_id  uuid NOT NULL,
    -- A bare uuid, not `REFERENCES users(id)`: who performed a merge is already on
    -- the merge's own audit row, and pointing this at `users` would enrol it in the
    -- whole-schema member-history contract for no benefit to either.
    actor_id      uuid,
    moved_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id)
);

CREATE INDEX idx_crm_party_attribution_moves_business
    ON crm_party_attribution_moves (business_id, moved_at);
CREATE INDEX idx_crm_party_attribution_moves_row
    ON crm_party_attribution_moves (business_id, table_name, row_id);

ALTER TABLE crm_party_attribution_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_party_attribution_moves FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_party_attribution_moves FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- The two merged guards, redefined with the attribution split out
-- ---------------------------------------------------------------------------
-- Both bodies are 0274's and 0276's verbatim except for the block each now carries
-- in place of two lines of its freeze comparison. Neither function is edited in
-- place: an applied migration's checksum is in `schema_migrations`, and amending
-- one forward is the only change that reaches an install that already ran it.

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
               OR NEW.approver_name IS DISTINCT FROM OLD.approver_name THEN
                RAISE EXCEPTION 'agency_client_briefs: a confirmed brief is frozen'
                    USING ERRCODE = '23514';
            END IF;

            -- Client attribution is split out of the freeze above, and the split is
            -- the fix rather than a relaxation. Until 0279 these two columns sat
            -- inside the frozen-substance comparison, which made a confirmed brief
            -- and a sent proposal *unmergeable*: `mergeCustomers` re-points every
            -- reference the registry classifies as `move`, the loser's client is one
            -- of them, and the guard refused — so the CRM's duplicates screen
            -- answered a raw SQLSTATE for a merge that is ordinary hygiene. A merge is
            -- not an edit of what the client agreed to; it is a statement that two
            -- records were always one. 0217's journal lines drew exactly this line,
            -- and this follows it: the substance stays immutable always, and the
            -- attribution may move only for a merge that has already audited itself.
            --
            -- The flag is transaction-local and is set by `mergeCustomers` only for a
            -- reference that declares a `preMoveSql`, so the audit row lands first
            -- and every other session still hits this guard.
            IF (NEW.party_id IS DISTINCT FROM OLD.party_id
                OR NEW.approver_party_id IS DISTINCT FROM OLD.approver_party_id)
               AND current_setting('app.ledger_party_move', true) IS DISTINCT FROM 'on' THEN
                RAISE EXCEPTION 'agency_client_briefs: client attribution moves only through an audited party merge'
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
               OR NEW.brief_id IS DISTINCT FROM OLD.brief_id
               OR NEW.client_contact_name IS DISTINCT FROM OLD.client_contact_name THEN
                RAISE EXCEPTION 'agency_proposals: a sent proposal is frozen; issue a new one to change the offer'
                    USING ERRCODE = '23514';
            END IF;

            -- Client attribution is split out of the freeze above, and the split is
            -- the fix rather than a relaxation. Until 0279 these two columns sat
            -- inside the frozen-substance comparison, which made a confirmed brief
            -- and a sent proposal *unmergeable*: `mergeCustomers` re-points every
            -- reference the registry classifies as `move`, the loser's client is one
            -- of them, and the guard refused — so the CRM's duplicates screen
            -- answered a raw SQLSTATE for a merge that is ordinary hygiene. A merge is
            -- not an edit of what the client agreed to; it is a statement that two
            -- records were always one. 0217's journal lines drew exactly this line,
            -- and this follows it: the substance stays immutable always, and the
            -- attribution may move only for a merge that has already audited itself.
            --
            -- The flag is transaction-local and is set by `mergeCustomers` only for a
            -- reference that declares a `preMoveSql`, so the audit row lands first
            -- and every other session still hits this guard.
            IF (NEW.party_id IS DISTINCT FROM OLD.party_id
                OR NEW.client_contact_party_id IS DISTINCT FROM OLD.client_contact_party_id)
               AND current_setting('app.ledger_party_move', true) IS DISTINCT FROM 'on' THEN
                RAISE EXCEPTION 'agency_proposals: client attribution moves only through an audited party merge'
                    USING ERRCODE = '23514';
            END IF;
        END IF;

        -- An offer with nothing on it is not an offer. Checked on the way out of
        -- `draft` rather than on insert, because a proposal is built line by line
        -- and the first save legitimately has none.
        --
        -- `withdrawn` is exempt, and the exemption is the point of the rule rather
        -- than an escape from it: what is being prevented is an *empty offer
        -- reaching the client*, and withdrawing one shows it to nobody. Refusing
        -- here would strand a half-written draft that its author wants gone —
        -- unable to be sent, unable to be withdrawn, deletable only because it is
        -- still a draft, which is a corner with one exit in it.
        IF OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'withdrawn') THEN
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
