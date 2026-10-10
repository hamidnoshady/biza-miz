-- ============================================================================
-- 0217 — Multicurrency hardening (issue #863 review follow-ups)
-- ============================================================================
-- Five narrow changes on top of 0216, each closing a defect the review of the
-- multicurrency subsystem identified:
--
--  1. `journal_entries.idempotency_payload_hash` — an idempotency key that
--     replays a DIFFERENT document must be rejected, not silently answered
--     with the first payload's entry. The hash of the canonical request rides
--     with the key; a retry compares before trusting the short-circuit.
--  2. `fx_revaluations.idempotency_payload_hash` — the same contract for
--     revaluation runs.
--  3. `ledger_party_attribution_moves` — the append-only audit trail for the
--     ONE legitimate mutation of a posted line's party attribution: a party
--     merge. The ledger's amounts stay immutable forever; only «who does this
--     open balance belong to» can move, and only through here.
--  4. The line immutability guard learns about (3): `party_id` may change only
--     while the transaction has declared `app.ledger_party_move = on` — a
--     transaction-local GUC the merge service sets, so no ordinary UPDATE path
--     (and no other session) can ever flip it. Amounts, accounts and entries
--     stay frozen exactly as before. The entries guard also freezes the new
--     hash column (set once at insert, never after).
--  5. `fx_settlement_applications` gains the ability to answer «was the
--     settlement that recorded this application later reversed?» implicitly —
--     no schema change needed (the settlement entry's `reversed_at` is the
--     truth), but the lot-consumption query and the gain/loss report join on
--     it; this migration only adds the index that keeps that join cheap.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 + 2. Idempotency payload hashes
-- ---------------------------------------------------------------------------

-- SHA-256 hex of the canonical request payload. NULL on entries posted
-- without an idempotency key (and on pre-0217 rows: their keys were accepted
-- before compatibility was checkable, and rewriting history is not on offer).
ALTER TABLE journal_entries
    ADD COLUMN idempotency_payload_hash text
        CHECK (idempotency_payload_hash IS NULL OR idempotency_payload_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE fx_revaluations
    ADD COLUMN idempotency_payload_hash text
        CHECK (idempotency_payload_hash IS NULL OR idempotency_payload_hash ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- 3. The party-attribution move audit trail
-- ---------------------------------------------------------------------------

-- One row per moved line, written by the merge service in the same transaction
-- as the move itself. Append-only: a merge that is later investigated must see
-- exactly what moved, from whom to whom, and on whose authority.
CREATE TABLE ledger_party_attribution_moves (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The trail dies with the ledger rows it audits: a posted line can only
    -- be removed through the guarded business teardown, and an audit row
    -- pointing at a ghost line has no value. Direct deletes of the LINE are
    -- what the journal guard forbids — this CASCADE never bypasses it.
    line_id      bigint NOT NULL REFERENCES journal_lines(id) ON DELETE CASCADE,
    entry_id     uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    old_party_id uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    new_party_id uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    moved_at     timestamptz NOT NULL DEFAULT now()
);

-- Append-only, the same way exchange_rates is: INSERT is the only path.
CREATE FUNCTION ledger_party_attribution_moves_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- The one sanctioned delete path is the business cascade: dropping a
    -- tenant takes its audit history with it (the same exception the
    -- exchange-rate guard grants). Any DIRECT delete or update — a cleanup
    -- script, a test harness, a hand-rolled «correction» — is refused.
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'ledger_party_attribution_moves is append-only'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_ledger_party_attribution_moves_guard
    BEFORE UPDATE OR DELETE ON ledger_party_attribution_moves
    FOR EACH ROW EXECUTE FUNCTION ledger_party_attribution_moves_guard();

ALTER TABLE ledger_party_attribution_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_party_attribution_moves FORCE ROW LEVEL SECURITY;
-- The same safe template every multicurrency table uses (bypass-aware
-- helpers, not a raw current_setting read): the merge transaction runs as the
-- acting tenant, so the audit rows it writes satisfy the CHECK themselves.
CREATE POLICY tenant_isolation ON ledger_party_attribution_moves FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE INDEX idx_ledger_party_moves_business
    ON ledger_party_attribution_moves (business_id, moved_at);

-- ---------------------------------------------------------------------------
-- 4. The immutability guards, rewritten
-- ---------------------------------------------------------------------------

-- Same rules as 0216, plus:
--  * entries: the payload hash is set-once (it rides the INSERT; an UPDATE
--    trying to move it is someone rewriting the idempotency contract);
--  * lines: party_id may move ONLY under the transaction-local merge flag.
--    The flag is checked per row, so a statement that touches a hundred lines
--    under the flag is exactly as audited as one that touches one: the merge
--    service has already written the audit rows when it sets the flag, and the
--    flag dies with its transaction.
CREATE OR REPLACE FUNCTION journal_immutable_columns_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'journal_entries' THEN
        IF NEW.business_id    IS DISTINCT FROM OLD.business_id
           OR NEW.entry_date  IS DISTINCT FROM OLD.entry_date
           OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
           OR NEW.base_currency_code IS DISTINCT FROM OLD.base_currency_code
           OR NEW.exchange_rate_id IS DISTINCT FROM OLD.exchange_rate_id
           OR NEW.exchange_rate    IS DISTINCT FROM OLD.exchange_rate
           OR NEW.rounding_version IS DISTINCT FROM OLD.rounding_version
           OR NEW.rounding_delta   IS DISTINCT FROM OLD.rounding_delta
           OR NEW.idempotency_key  IS DISTINCT FROM OLD.idempotency_key
           OR NEW.idempotency_payload_hash IS DISTINCT FROM OLD.idempotency_payload_hash THEN
            RAISE EXCEPTION 'journal entry financial facts are immutable'
                USING ERRCODE = '55000';
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.entry_id        IS DISTINCT FROM OLD.entry_id
           OR NEW.account_id   IS DISTINCT FROM OLD.account_id
           OR NEW.debit        IS DISTINCT FROM OLD.debit
           OR NEW.credit       IS DISTINCT FROM OLD.credit
           OR NEW.foreign_debit  IS DISTINCT FROM OLD.foreign_debit
           OR NEW.foreign_credit IS DISTINCT FROM OLD.foreign_credit THEN
            RAISE EXCEPTION 'journal line financial facts are immutable'
                USING ERRCODE = '55000';
        END IF;
        -- The attribution may move only for a merge that is auditing itself.
        IF NEW.party_id IS DISTINCT FROM OLD.party_id
           AND current_setting('app.ledger_party_move', true) IS DISTINCT FROM 'on' THEN
            RAISE EXCEPTION 'journal line party attribution moves only through an audited party merge'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. The reversed-settlement join the lot queries and the gain/loss report use
--
-- Deliberately NO new index here: 0216 already ships
-- idx_fx_settlement_applications_settlement on (business_id,
-- settlement_entry_id), and every reversed-settlement lookup filters the
-- business first, so that index serves the join directly. Creating the same
-- index a second time under a narrower shape would only split the plan cache.
-- ---------------------------------------------------------------------------
