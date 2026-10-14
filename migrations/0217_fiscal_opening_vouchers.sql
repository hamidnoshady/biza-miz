-- ---------------------------------------------------------------------------
-- Issue #867 — accountant opening balances, fiscal carry-forward and formal
-- voucher numbering.
--
-- Three additions, all metadata/derived over the existing ledger:
--
--  1. Voucher numbers on `journal_entries` itself. A stable, printable,
--     fiscal-year scoped number (`MJ-1404-000012`) is *metadata on the entry*
--     — no document table stands in for a journal entry, so there is no
--     second posting truth. `voucher_sequences` owns the per
--     (business, fiscal year, document type) counter; `voucher_renumber_log`
--     is the append-only audit trail of every renumber. A trigger refuses a
--     direct update of the voucher columns unless the renumber service set a
--     transaction-local flag in the same transaction that writes the audit
--     row — renumbering is privileged and auditable at the database, not
--     merely at the API.
--
--  2. `opening_balance_sets` / `opening_balance_lines` — the accountant's
--     opening-balance workspace (draft → review → approved → posted, plus
--     controlled reversal). Posting calls the ordinary `postJournalEntry`
--     path, so the migration-0024 period-lock trigger, RLS and every report
--     apply with no special case. A set's lines may carry party attribution
--     (customer / supplier / cheque / fixed asset / inventory) so A/R and A/P
--     openings keep their per-party detail and cheque/open-item identity
--     survives a carry-forward.
--
--  3. `summary_vouchers` / `summary_voucher_sources` — aggregation documents
--     over a defined source set of journal entries. They reference entries
--     (with a snapshot of each entry's own number and totals); they never
--     post, never modify, and `UNIQUE (journal_entry_id)` across the sources
--     table is the double-inclusion guard.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Voucher numbering
-- ===========================================================================

ALTER TABLE journal_entries
    ADD COLUMN voucher_number     text,
    ADD COLUMN voucher_sequence_no bigint,
    -- The accountant's own reference number (e.g. the number the document
    -- carried in the system being migrated off). Advisory only: it never
    -- participates in the fiscal-year sequence and nothing here validates it
    -- beyond its stored shape — the service does, so the screen and the API
    -- agree.
    ADD COLUMN voucher_reference  text CHECK (voucher_reference IS NULL OR voucher_reference ~ '^[A-Za-z0-9._/-]{1,64}$'),
    -- NULL means the number was assigned by the posting path itself. A user
    -- id means a renumber touched the entry (see voucher_renumber_log).
    ADD COLUMN voucher_assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN voucher_assigned_at timestamptz,
    ADD CONSTRAINT journal_entries_voucher_sequence_non_negative
        CHECK (voucher_sequence_no IS NULL OR voucher_sequence_no > 0);

-- The number is unique per business: the fiscal year and document type are
-- part of the printed number, so a business-wide uniqueness is the right
-- grain (and the simple one).
CREATE UNIQUE INDEX uq_journal_entries_voucher_number
    ON journal_entries (business_id, voucher_number)
    WHERE voucher_number IS NOT NULL;
CREATE INDEX idx_journal_entries_voucher_sequence
    ON journal_entries (business_id, voucher_sequence_no)
    WHERE voucher_number IS NOT NULL;

-- Per (business, fiscal year, document type) counter. `fiscal_year_id` links
-- the row to the defined fiscal year when one exists; `fiscal_year_label`
-- (the Jalali year, e.g. '1404') carries the identity on its own, because a
-- business may have entries dated in a year it has not defined periods for.
CREATE TABLE voucher_sequences (
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    fiscal_year_id    uuid REFERENCES fiscal_years(id) ON DELETE CASCADE,
    fiscal_year_label text NOT NULL CHECK (fiscal_year_label ~ '^[0-9]{4}$'),
    document_type     text NOT NULL CHECK (document_type IN ('journal', 'manual', 'opening', 'summary')),
    last_number       bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, fiscal_year_label, document_type)
);
CREATE INDEX idx_voucher_sequences_business ON voucher_sequences (business_id);

ALTER TABLE voucher_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voucher_sequences FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Append-only audit trail: one row per renumber (and per backfill assignment
-- to a pre-existing entry, where `previous_number` is NULL).
CREATE TABLE voucher_renumber_log (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    journal_entry_id   uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    fiscal_year_label  text NOT NULL,
    document_type      text NOT NULL,
    previous_number    text,
    new_number         text NOT NULL,
    previous_sequence_no bigint,
    new_sequence_no    bigint,
    reason             text NOT NULL CHECK (length(btrim(reason)) > 0),
    performed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_voucher_renumber_log_business ON voucher_renumber_log (business_id, created_at DESC);
CREATE INDEX idx_voucher_renumber_log_entry ON voucher_renumber_log (journal_entry_id);

ALTER TABLE voucher_renumber_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_renumber_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voucher_renumber_log FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Direct edits to the voucher columns are refused unless the renumber service
-- set `app.allow_voucher_renumber` for this transaction — the same
-- transaction that writes the audit row.
--
-- A first assignment is not a renumber: an entry that has never been numbered
-- (voucher_number IS NULL) may take its number from the posting path or the
-- deterministic backfill without the flag. Changing a number that already
-- exists is privileged, whatever the connection, and is only legal inside the
-- service's transaction, which also writes the audit row.
CREATE OR REPLACE FUNCTION guard_journal_voucher_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- COALESCE is load-bearing: on a connection that never set the GUC,
    -- current_setting(..., true) is NULL and `NULL <> 'on'` is NULL, which a
    -- PL/pgSQL IF treats as false — the guard would silently stand down.
    IF OLD.voucher_number IS NOT NULL
       AND (NEW.voucher_number IS DISTINCT FROM OLD.voucher_number
        OR NEW.voucher_sequence_no IS DISTINCT FROM OLD.voucher_sequence_no
        OR NEW.voucher_reference IS DISTINCT FROM OLD.voucher_reference
        OR NEW.voucher_assigned_by IS DISTINCT FROM OLD.voucher_assigned_by
        OR NEW.voucher_assigned_at IS DISTINCT FROM OLD.voucher_assigned_at)
       AND COALESCE(current_setting('app.allow_voucher_renumber', true), '') <> 'on' THEN
        RAISE EXCEPTION 'voucher number changes are privileged: use the renumber service with an audit row'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_journal_voucher_columns
    BEFORE UPDATE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION guard_journal_voucher_columns();

-- ===========================================================================
-- 2. Opening balance sets
-- ===========================================================================

CREATE TYPE opening_set_status AS ENUM ('draft', 'review', 'approved', 'posted', 'reversed');
CREATE TYPE opening_set_source AS ENUM ('manual', 'carry_forward');

CREATE TABLE opening_balance_sets (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The fiscal year identity. The label is the Jalali year (e.g. '1404')
    -- and always present; the id links to the defined fiscal year when the
    -- business has one, so a report can answer both "which year" and
    -- "which year record" from the set itself.
    fiscal_year_label       text NOT NULL CHECK (fiscal_year_label ~ '^[0-9]{4}$'),
    fiscal_year_id          uuid REFERENCES fiscal_years(id) ON DELETE SET NULL,
    -- The day the balances are effective from: the entry it posts to is dated
    -- here, and "dependent postings" for the reversal guard means any other
    -- entry dated after this day.
    effective_date          date NOT NULL,
    status                  opening_set_status NOT NULL DEFAULT 'draft',
    source                  opening_set_source NOT NULL DEFAULT 'manual',
    -- For a carry-forward proposal: the prior fiscal year whose close fed it.
    carry_forward_from_year_id uuid REFERENCES fiscal_years(id) ON DELETE SET NULL,
    -- Set when the set is posted / reversed.
    journal_entry_id        uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    reversal_entry_id       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    total_debit             bigint NOT NULL DEFAULT 0 CHECK (total_debit >= 0),
    total_credit            bigint NOT NULL DEFAULT 0 CHECK (total_credit >= 0),
    note                    text,
    created_by              uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    submitted_at            timestamptz,
    submitted_by            uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at             timestamptz,
    approved_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    posted_at               timestamptz,
    posted_by               uuid REFERENCES users(id) ON DELETE SET NULL,
    reversed_at             timestamptz,
    reversed_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    reversed_reason         text,
    -- A business carries one opening set per fiscal year: the one that is
    -- (or was) posted. Reversed sets fall out of the index, which is what
    -- lets a corrected set post for the same year.
    CONSTRAINT opening_balance_sets_balanced CHECK (total_debit = total_credit),
    CONSTRAINT opening_balance_sets_carry_forward_year
        CHECK (source <> 'carry_forward' OR carry_forward_from_year_id IS NOT NULL)
);

CREATE UNIQUE INDEX uq_opening_balance_sets_posted_per_year
    ON opening_balance_sets (business_id, fiscal_year_label)
    WHERE status = 'posted';
-- Carry-forward generation is idempotent: one proposal per prior year.
CREATE UNIQUE INDEX uq_opening_balance_sets_carry_forward
    ON opening_balance_sets (business_id, carry_forward_from_year_id)
    WHERE source = 'carry_forward' AND carry_forward_from_year_id IS NOT NULL;
CREATE INDEX idx_opening_balance_sets_business ON opening_balance_sets (business_id, status);

ALTER TABLE opening_balance_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE opening_balance_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON opening_balance_sets FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- One GL line per account side. Party attribution is optional on a line —
-- a plain opening line has none; a carry-forward line for a customer's A/R
-- balance carries customer + the subledger's open-item detail in `reference`
-- so the attribution survives the transition.
CREATE TABLE opening_balance_lines (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    set_id      uuid NOT NULL REFERENCES opening_balance_sets(id) ON DELETE CASCADE,
    account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    debit       bigint NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit      bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
    party_type  text CHECK (party_type IS NULL OR party_type IN ('customer', 'supplier', 'cheque', 'fixed_asset', 'inventory')),
    party_id    uuid,
    -- Cheque serial / Sayad id, an asset id, a party note — the identity the
    -- line points at, kept here rather than reconstructed on every read.
    reference   text,
    source_note text,
    CONSTRAINT opening_balance_lines_debit_xor_credit
        CHECK ((debit = 0) <> (credit = 0)),
    CONSTRAINT opening_balance_lines_party_consistent
        CHECK ((party_type IS NULL) = (party_id IS NULL))
);
CREATE INDEX idx_opening_balance_lines_set ON opening_balance_lines (set_id);
CREATE INDEX idx_opening_balance_lines_account ON opening_balance_lines (account_id);

ALTER TABLE opening_balance_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE opening_balance_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON opening_balance_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM opening_balance_sets s
         WHERE s.id = opening_balance_lines.set_id
           AND s.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM opening_balance_sets s
         WHERE s.id = opening_balance_lines.set_id
           AND s.business_id = app_current_business()));

-- The set's lifecycle is one-way and lines freeze at submission: a
-- review/approved/posted set is a document, not a scratchpad. The only legal
-- transitions are the forward steps plus posted → reversed (the controlled
-- reversal, which posts a mirror entry — never a line edit). Anything else is
-- refused here rather than trusted at the app layer, the same way the period
-- lock is a trigger.
CREATE OR REPLACE FUNCTION guard_opening_balance_set_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> NEW.status THEN
        IF (OLD.status = 'draft'    AND NEW.status <> 'review')
           OR (OLD.status = 'review'   AND NEW.status <> 'approved')
           OR (OLD.status = 'approved' AND NEW.status <> 'posted')
           OR (OLD.status = 'posted'   AND NEW.status <> 'reversed')
           OR OLD.status = 'reversed' THEN
            RAISE EXCEPTION 'invalid_opening_set_transition: % -> %', OLD.status, NEW.status
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_opening_balance_set_state
    BEFORE UPDATE ON opening_balance_sets
    FOR EACH ROW EXECUTE FUNCTION guard_opening_balance_set_state();

-- ===========================================================================
-- 3. Summary vouchers
-- ===========================================================================

CREATE TABLE summary_vouchers (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    fiscal_year_id   uuid REFERENCES fiscal_years(id) ON DELETE SET NULL,
    -- Assigned from the 'summary' sequence at generation.
    voucher_number   text NOT NULL,
    label            text NOT NULL CHECK (length(btrim(label)) > 0),
    -- The defined source set this voucher aggregates over: which source
    -- types, which date cutoff, which explicit entries — the traceability is
    -- the scope plus the sources table, and both are frozen once written.
    scope            jsonb NOT NULL,
    entry_count      integer NOT NULL CHECK (entry_count >= 0),
    total_debit      bigint NOT NULL CHECK (total_debit >= 0),
    total_credit     bigint NOT NULL CHECK (total_credit >= 0),
    -- Idempotent retry: a client-generated key, when present, returns the
    -- original voucher instead of a second aggregation of the same set.
    idempotency_key  text CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9._-]{1,128}$'),
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT summary_vouchers_balanced CHECK (total_debit = total_credit)
);
CREATE INDEX idx_summary_vouchers_business ON summary_vouchers (business_id, created_at DESC);
CREATE UNIQUE INDEX uq_summary_vouchers_idempotency
    ON summary_vouchers (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE summary_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE summary_vouchers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON summary_vouchers FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- One row per source entry. `UNIQUE (journal_entry_id)` — across the whole
-- table, every business — is the double-inclusion guard: an entry can appear
-- in exactly one summary voucher, ever. The snapshots (the entry's own
-- number, date, totals at generation time) are what "traceable" reads from:
-- renumbering or reporting the sources later never re-derives what the
-- voucher aggregated.
CREATE TABLE summary_voucher_sources (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    summary_voucher_id  uuid NOT NULL REFERENCES summary_vouchers(id) ON DELETE CASCADE,
    journal_entry_id    uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    entry_date          date NOT NULL,
    source_type         text,
    entry_voucher_number text,
    total_debit         bigint NOT NULL CHECK (total_debit >= 0),
    total_credit        bigint NOT NULL CHECK (total_credit >= 0)
);
CREATE UNIQUE INDEX uq_summary_voucher_sources_entry ON summary_voucher_sources (journal_entry_id);
CREATE INDEX idx_summary_voucher_sources_voucher ON summary_voucher_sources (summary_voucher_id);

ALTER TABLE summary_voucher_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE summary_voucher_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON summary_voucher_sources FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
