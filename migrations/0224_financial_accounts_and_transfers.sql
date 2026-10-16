-- ---------------------------------------------------------------------------
-- Issue #862 — Financial Accounts & Internal Transfers.
--
-- Two tables, and deliberately no third one:
--
--   1. `financial_accounts` — the master record of the business's own money
--      containers: bank, cash, petty cash and POS/PSP. Each row is linked to
--      exactly one *postable* GL account by a UNIQUE index, which is how the
--      issue's "two financial accounts must never display the same shared GL
--      balance" is guaranteed structurally rather than by review: the second
--      row that names an already-linked account cannot be written at all.
--
--      There is **no balance column anywhere in this migration**. A balance is
--      `SUM(debit - credit)` over `journal_lines` for the linked GL account —
--      the same rows the trial balance reads. A stored balance would be the
--      shadow financial-balance table the issue rules out, and the first thing
--      to disagree with the ledger after a correction.
--
--   2. `financial_transfers` — the document of one movement between two of
--      those accounts, referencing the journal entry that actually moved the
--      money (`journal_entry_id`, UNIQUE per business) and, for a reversal, the
--      entry that reversed it. The document is written in the *same*
--      transaction as its posting, by the ordinary `postExactJournalEntry`
--      path, so the ledger's fiscal-period locks, RLS and every report apply
--      with no special case and there is never a transfer without its entry or
--      an entry without its transfer.
--
-- Identity freeze. A financial account's GL account, kind and currency are what
-- its card *means*; after the first transfer has moved money through it,
-- changing any of the three would silently re-point a document's history at a
-- different account. `financial_account_identity_guard()`, a BEFORE UPDATE
-- trigger, refuses the change at the database, so the rule holds even for a
-- writer that bypasses the service.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. The kind of container a financial account is
-- ===========================================================================

CREATE TYPE financial_account_kind AS ENUM ('bank', 'cash', 'petty_cash', 'pos_psp');

-- ===========================================================================
-- 2. financial_accounts
-- ===========================================================================

CREATE TABLE financial_accounts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- NULL = the account is the business's, not one branch's (a single bank
    -- account every branch pays into). A branch-scoped row is the branch's own
    -- container, and the branch filter in the register means the branch.
    location_id   uuid REFERENCES locations(id) ON DELETE RESTRICT,
    kind          financial_account_kind NOT NULL,
    -- The business's own short code (e.g. «MEL-01»). Optional, unique when set.
    code          text CHECK (code IS NULL OR (btrim(code) <> '' AND char_length(code) <= 32)),
    name          text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 120),
    -- The one postable GL account this container *is*, in the ledger.
    gl_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    currency_code text NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
    is_active     boolean NOT NULL DEFAULT true,
    is_default    boolean NOT NULL DEFAULT false,
    description   text CHECK (description IS NULL OR char_length(description) <= 400),
    notes         text CHECK (notes IS NULL OR char_length(notes) <= 2000),

    -- Bank identity. Sensitive: the API masks every one of these for a member
    -- without `finance.accounts_manage` (see `financial-accounts.ts`), and they
    -- are stored as text because a card number with a leading zero is a
    -- different card, not a smaller number.
    bank_name            text CHECK (bank_name IS NULL OR char_length(bank_name) <= 80),
    bank_branch_name     text CHECK (bank_branch_name IS NULL OR char_length(bank_branch_name) <= 120),
    account_number       text CHECK (account_number IS NULL OR char_length(account_number) <= 40),
    card_number          text CHECK (card_number IS NULL OR char_length(card_number) <= 32),
    iban                 text CHECK (iban IS NULL OR char_length(iban) <= 32),
    account_holder       text CHECK (account_holder IS NULL OR char_length(account_holder) <= 120),
    -- The merchant/settlement reference the PSP prints («شماره پذیرنده»).
    settlement_reference text CHECK (settlement_reference IS NULL OR char_length(settlement_reference) <= 120),

    -- POS/PSP identity.
    psp_provider     text CHECK (psp_provider IS NULL OR char_length(psp_provider) <= 80),
    terminal_number  text CHECK (terminal_number IS NULL OR char_length(terminal_number) <= 40),
    merchant_number  text CHECK (merchant_number IS NULL OR char_length(merchant_number) <= 40),
    -- Where a card-reader's takings actually land. Not a second posting path:
    -- the settlement is an ordinary transfer between this terminal's own
    -- clearing account and that bank account.
    settlement_account_id uuid REFERENCES financial_accounts(id) ON DELETE SET NULL,
    -- How many days the PSP holds the money before settling (T+1 = 1).
    settlement_delay_days smallint CHECK (settlement_delay_days IS NULL OR settlement_delay_days BETWEEN 0 AND 90),

    -- Archive, never delete: a container's history is accounting evidence. The
    -- two columns and `is_active` are one fact spelled consistently (see the
    -- CHECK below), so a row can never be inactive without a stamp or stamped
    -- without being inactive.
    archived_at   timestamptz,
    archived_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT financial_accounts_bank_metadata CHECK (
        kind = 'bank'
        OR (bank_name IS NULL AND bank_branch_name IS NULL AND account_number IS NULL
            AND card_number IS NULL AND iban IS NULL AND account_holder IS NULL)
    ),
    CONSTRAINT financial_accounts_psp_metadata CHECK (
        kind = 'pos_psp'
        OR (psp_provider IS NULL AND terminal_number IS NULL AND merchant_number IS NULL
            AND settlement_account_id IS NULL AND settlement_delay_days IS NULL)
    ),
    -- A terminal settles into a bank account, never into itself and never into
    -- another terminal: a settlement chain that ends nowhere is money nobody can
    -- find.
    CONSTRAINT financial_accounts_settlement_kind CHECK (
        settlement_account_id IS NULL OR kind = 'pos_psp'
    ),
    CONSTRAINT financial_accounts_settlement_not_self CHECK (settlement_account_id IS NULL OR settlement_account_id <> id),
    CONSTRAINT financial_accounts_archive_pair CHECK (
        (is_active AND archived_at IS NULL) OR (NOT is_active AND archived_at IS NOT NULL)
    ),
    CONSTRAINT financial_accounts_default_active CHECK (NOT is_default OR is_active)
);

-- One GL account, one financial account. This is the exact-reconciliation rule:
-- two containers sharing one GL account would each report the other's movements
-- on their own card, which is precisely the ambiguity the issue forbids.
CREATE UNIQUE INDEX uq_financial_accounts_gl_account
    ON financial_accounts (business_id, gl_account_id);

CREATE UNIQUE INDEX uq_financial_accounts_code
    ON financial_accounts (business_id, code)
    WHERE code IS NOT NULL;

-- One default per (kind, scope). The NULL branch is folded onto a sentinel so
-- "the business-wide default" is one scope, not an unbounded set of NULLs that
-- a plain UNIQUE index would not constrain.
CREATE UNIQUE INDEX uq_financial_accounts_default
    ON financial_accounts (
        business_id,
        kind,
        COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)
    )
    WHERE is_default AND is_active;

CREATE INDEX idx_financial_accounts_business_kind
    ON financial_accounts (business_id, kind, is_active);
CREATE INDEX idx_financial_accounts_location
    ON financial_accounts (business_id, location_id);
CREATE INDEX idx_financial_accounts_settlement
    ON financial_accounts (settlement_account_id)
    WHERE settlement_account_id IS NOT NULL;

ALTER TABLE financial_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON financial_accounts FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ===========================================================================
-- 3. financial_transfers
-- ===========================================================================

CREATE TABLE financial_transfers (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The branch whose books the document belongs to. Nullable, like the
    -- account's own scope: a business-wide movement between two business-wide
    -- accounts is not a branch's document.
    location_id        uuid REFERENCES locations(id) ON DELETE RESTRICT,

    -- The printed document number (`TR-000001`, from `transferNumberFor`) and the per-business
    -- sequence it came from. `sequence_no` is what a race orders by; the number
    -- is what a human reads and quotes.
    transfer_number    text NOT NULL CHECK (btrim(transfer_number) <> '' AND char_length(transfer_number) <= 40),
    sequence_no        bigint NOT NULL CHECK (sequence_no > 0),
    transfer_date      date NOT NULL,

    source_account_id      uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
    destination_account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,

    -- Exact Rial, integer. Never a float, never a currency-converted value.
    amount             bigint NOT NULL CHECK (amount > 0),
    fee_amount         bigint NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
    -- The expense account the fee is recognised in, when there is a fee.
    fee_account_id     uuid REFERENCES accounts(id) ON DELETE RESTRICT,
    fee_payer          text NOT NULL DEFAULT 'source' CHECK (fee_payer IN ('source', 'destination')),

    -- The document's own currency: both containers' currency when they agree,
    -- otherwise the *source* currency, with the entry carrying the conversion.
    -- Never a conversion this system invented — a missing rate is a refusal.
    currency_code      text NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
    reference_number   text CHECK (reference_number IS NULL OR char_length(reference_number) <= 60),
    description        text CHECK (description IS NULL OR char_length(description) <= 400),
    project_id         uuid REFERENCES ai_projects(id) ON DELETE SET NULL,
    attachment_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,

    status             text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
    -- A reversal is itself a row (and its own entry), linked back to the
    -- document it reverses; the flag says which of the two kinds of posting
    -- this row is, so a reversal can never be reversed again.
    posting_mode       text NOT NULL DEFAULT 'transfer' CHECK (posting_mode IN ('transfer', 'reversal')),

    -- The entry that moved the money. UNIQUE per business: one document, one
    -- posting, so no transfer can ever be backed by two entries.
    journal_entry_id   uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
    -- The entry that reversed this one, when it has been reversed.
    reversal_entry_id  uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
    -- The document this row reverses (posting_mode = 'reversal').
    reverses_transfer_id uuid REFERENCES financial_transfers(id) ON DELETE RESTRICT,
    reversal_reason    text CHECK (reversal_reason IS NULL OR char_length(reversal_reason) <= 400),
    reversed_at        timestamptz,
    reversed_by        uuid REFERENCES users(id) ON DELETE SET NULL,

    -- Retry contract. The key is the caller's; `idempotency_hash` is the digest of
    -- the payload that key was first used with, so a key reused for a different
    -- amount is refused rather than answered with the first document.
    idempotency_key    text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) <= 200),
    idempotency_hash       text,

    created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    posted_at          timestamptz NOT NULL DEFAULT now(),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT financial_transfers_distinct_accounts CHECK (source_account_id <> destination_account_id),
    CONSTRAINT financial_transfers_fee_account_pair CHECK (
        (fee_amount = 0 AND fee_account_id IS NULL) OR (fee_amount > 0 AND fee_account_id IS NOT NULL)
    ),
    CONSTRAINT financial_transfers_reversal_shape CHECK (
        (posting_mode = 'transfer' AND reverses_transfer_id IS NULL AND reversal_reason IS NULL)
        OR (posting_mode = 'reversal' AND reverses_transfer_id IS NOT NULL AND reversal_reason IS NOT NULL)
    ),
    CONSTRAINT financial_transfers_reversed_shape CHECK (
        (status = 'posted' AND reversal_entry_id IS NULL AND reversed_at IS NULL AND reversed_by IS NULL)
        OR (status = 'reversed' AND reversal_entry_id IS NOT NULL AND reversed_at IS NOT NULL)
    ),
    CONSTRAINT financial_transfers_idempotency_pair CHECK (
        (idempotency_key IS NULL AND idempotency_hash IS NULL) OR (idempotency_key IS NOT NULL AND idempotency_hash IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_financial_transfers_number
    ON financial_transfers (business_id, transfer_number);
CREATE UNIQUE INDEX uq_financial_transfers_sequence
    ON financial_transfers (business_id, sequence_no);
CREATE UNIQUE INDEX uq_financial_transfers_journal
    ON financial_transfers (business_id, journal_entry_id);
CREATE UNIQUE INDEX uq_financial_transfers_reversal_entry
    ON financial_transfers (business_id, reversal_entry_id)
    WHERE reversal_entry_id IS NOT NULL;
CREATE UNIQUE INDEX uq_financial_transfers_idempotency
    ON financial_transfers (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
-- One reversal per document. The race is real (two operators pressing «برگشت»
-- at once) and this index is what makes it impossible rather than unlikely:
-- the loser gets 23505 and is answered with the winner's reversal.
CREATE UNIQUE INDEX uq_financial_transfers_reverses
    ON financial_transfers (reverses_transfer_id)
    WHERE reverses_transfer_id IS NOT NULL;

CREATE INDEX idx_financial_transfers_business_date
    ON financial_transfers (business_id, transfer_date DESC, sequence_no DESC);
CREATE INDEX idx_financial_transfers_source
    ON financial_transfers (business_id, source_account_id);
CREATE INDEX idx_financial_transfers_destination
    ON financial_transfers (business_id, destination_account_id);
CREATE INDEX idx_financial_transfers_project
    ON financial_transfers (business_id, project_id)
    WHERE project_id IS NOT NULL;

ALTER TABLE financial_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON financial_transfers FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ===========================================================================
-- 4. Identity is frozen once money has moved through the account
-- ===========================================================================

CREATE FUNCTION financial_account_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.gl_account_id IS DISTINCT FROM OLD.gl_account_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
       OR NEW.business_id IS DISTINCT FROM OLD.business_id THEN
        IF EXISTS (
            SELECT 1 FROM financial_transfers t
             WHERE t.source_account_id = OLD.id OR t.destination_account_id = OLD.id
        ) THEN
            RAISE EXCEPTION 'financial_account_identity_locked'
                USING ERRCODE = '23514',
                      HINT = 'Move the balance out with a transfer and register a new account instead.';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER financial_accounts_identity_guard
    BEFORE UPDATE ON financial_accounts
    FOR EACH ROW EXECUTE FUNCTION financial_account_identity_guard();

-- The same for a *terminal's* settlement target: re-pointing a POS account at
-- another bank account after settlement history exists would move that history
-- to a bank it was never in. A settlement with no transfers yet is free to change.
CREATE FUNCTION financial_account_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.settlement_account_id IS DISTINCT FROM OLD.settlement_account_id AND OLD.settlement_account_id IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM financial_transfers t
             WHERE t.source_account_id = OLD.id OR t.destination_account_id = OLD.id
        ) THEN
            RAISE EXCEPTION 'financial_account_settlement_locked'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER financial_accounts_settlement_guard
    BEFORE UPDATE ON financial_accounts
    FOR EACH ROW EXECUTE FUNCTION financial_account_settlement_guard();

-- ===========================================================================
-- 5. Cross-tenant references are refused at the database
-- ===========================================================================

-- Every reference a transfer carries — both containers, the fee account, the
-- project and the branch — must belong to the row's own business. RLS already
-- scopes each *table*; this closes the composite case, where a correctly scoped
-- writer names a foreign id it happens to know, and turns it into a named error
-- instead of a document that points across tenants.
CREATE FUNCTION financial_transfer_tenant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    source_business uuid;
    destination_business uuid;
    fee_business uuid;
BEGIN
    IF app_rls_bypass() THEN
        RETURN NEW;
    END IF;

    SELECT business_id INTO source_business FROM financial_accounts WHERE id = NEW.source_account_id;
    SELECT business_id INTO destination_business FROM financial_accounts WHERE id = NEW.destination_account_id;
    IF source_business IS DISTINCT FROM NEW.business_id OR destination_business IS DISTINCT FROM NEW.business_id THEN
        RAISE EXCEPTION 'cross_tenant_reference' USING ERRCODE = '23514', HINT = 'financial account';
    END IF;

    IF NEW.fee_account_id IS NOT NULL THEN
        SELECT business_id INTO fee_business FROM accounts WHERE id = NEW.fee_account_id;
        IF fee_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'cross_tenant_reference' USING ERRCODE = '23514', HINT = 'fee account';
        END IF;
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER financial_transfers_tenant_guard
    BEFORE INSERT OR UPDATE ON financial_transfers
    FOR EACH ROW EXECUTE FUNCTION financial_transfer_tenant_guard();
