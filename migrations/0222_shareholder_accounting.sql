-- ============================================================================
-- 0222_shareholder_accounting.sql — issue #864: shareholder register,
-- immutable ownership history, capital movements and profit distributions.
--
-- Identity remains in `parties`. This migration adds only the Accounting-owned
-- ownership/capital facts; it does not create a second person directory or a
-- second balance store. Every cash/equity/payment effect is a journal entry,
-- with `journal_lines.party_id` providing the shareholder subledger attribution.
--
-- Ownership is stored as an append-only stream of post-event snapshots. A
-- snapshot effective on D holds for [D, next effective date); therefore any
-- date in history is reconstructible without editing an earlier event. The
-- service serializes ownership changes per business, validates the configured
-- total policy over the full effective timeline, and requires the dedicated
-- retroactive permission for backdated events.
--
-- Profit distributions can be created only from a closed fiscal year's
-- approved closing entry. Each distribution line freezes its ownership
-- percentage, units and integer-Rial allocation at an explicit snapshot date.
-- Outstanding shareholder balances are always read from the GL; the tables
-- below retain source documents and allocation history, not a parallel balance.
--
-- All tenant tables use forced RLS in this migration.
-- ============================================================================

SELECT set_config('app.rls_bypass', 'on', true);

-- Accounts used by the shared shareholder posting rules. 0216's chart backfill
-- pattern is followed: custom charts that already use one of these codes are
-- left untouched; the service fails closed if a required code is absent or has
-- the wrong type. New-business templates receive the same accounts in
-- src/lib/coa-template.ts.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, v.is_contra
  FROM businesses b
 CROSS JOIN (VALUES
    ('2510', 'وام پرداختنی به سهام‌داران', 'liability', '2000', false),
    ('2520', 'سود سهام پرداختنی',          'liability', '2000', false),
    ('3150', 'سرمایه پرداخت‌شده اضافی',    'equity',     '3000', false)
 ) v(code, name, type, parent_code, is_contra)
  JOIN accounts p ON p.business_id = b.id AND p.code = v.parent_code
ON CONFLICT (business_id, code) DO NOTHING;

-- A policy is explicit and tenant-owned. The safe default allows unallocated
-- ownership (total <= 100%); the owner may opt into exactly 100% once all
-- shareholders are entered. The service checks every affected historical and
-- future effective date before a policy or event is committed.
CREATE TABLE shareholder_ownership_policies (
    business_id       uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    total_policy      text NOT NULL DEFAULT 'at_most_100'
                      CHECK (total_policy IN ('at_most_100', 'exactly_100')),
    updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_shareholder_ownership_policies_updated ON shareholder_ownership_policies (business_id, updated_at DESC);

INSERT INTO shareholder_ownership_policies (business_id, total_policy)
SELECT id, 'at_most_100' FROM businesses
ON CONFLICT (business_id) DO NOTHING;

ALTER TABLE shareholder_ownership_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE shareholder_ownership_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shareholder_ownership_policies FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- The shareholder is a canonical party with an Accounting relationship. There
-- is one register row per party, never a copied name, address or identity.
CREATE TABLE shareholder_accounts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    party_id    uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    UNIQUE (business_id, party_id)
);
CREATE INDEX idx_shareholder_accounts_party ON shareholder_accounts (party_id);

CREATE FUNCTION shareholder_account_affinity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    party_business uuid;
    party_active boolean;
    party_merged_into uuid;
    actor_business uuid;
BEGIN
    SELECT business_id, is_active, merged_into_id
      INTO party_business, party_active, party_merged_into
      FROM parties WHERE id = NEW.party_id;
    IF party_business IS NULL OR party_business <> NEW.business_id
       OR NOT party_active OR party_merged_into IS NOT NULL THEN
        RAISE EXCEPTION 'shareholder_party_business_mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.created_by IS NOT NULL THEN
        SELECT business_id INTO actor_business FROM users WHERE id = NEW.created_by;
        IF actor_business IS NULL OR actor_business <> NEW.business_id THEN
            RAISE EXCEPTION 'shareholder_actor_business_mismatch' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_shareholder_account_affinity
    BEFORE INSERT ON shareholder_accounts
    FOR EACH ROW EXECUTE FUNCTION shareholder_account_affinity_guard();

CREATE FUNCTION shareholder_account_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'shareholder_accounts is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_shareholder_accounts_append_only
    BEFORE UPDATE OR DELETE ON shareholder_accounts
    FOR EACH ROW EXECUTE FUNCTION shareholder_account_append_only_guard();

ALTER TABLE shareholder_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shareholder_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shareholder_accounts FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Immutable ownership and capital event stream. `ownership_percent` and
-- `share_units` are the after-state for ownership events; capital rows carry
-- integer Rial and a GL entry. A correction is a new row and a mirror journal,
-- never an UPDATE/DELETE of the source event.
CREATE TABLE shareholder_events (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id               uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    shareholder_id            uuid NOT NULL,
    event_type                text NOT NULL CHECK (event_type IN (
                                  'shareholder_added', 'ownership_changed', 'shareholder_removed',
                                  'ownership_transfer_out', 'ownership_transfer_in',
                                  'capital_contribution', 'capital_withdrawal', 'capital_reversal'
                              )),
    effective_on              date NOT NULL,
    ownership_percent         numeric(9,6) CHECK (ownership_percent IS NULL OR ownership_percent BETWEEN 0 AND 100),
    share_units               numeric(20,6) CHECK (share_units IS NULL OR share_units >= 0),
    transfer_percent          numeric(9,6) CHECK (transfer_percent IS NULL OR transfer_percent > 0),
    transfer_group_id          uuid,
    capital_class             text CHECK (capital_class IS NULL OR capital_class IN ('equity', 'additional_paid_in_capital', 'shareholder_loan')),
    amount_rial               bigint CHECK (amount_rial IS NULL OR amount_rial > 0),
    payment_account_id        uuid REFERENCES accounts(id) ON DELETE RESTRICT,
    journal_entry_id          uuid REFERENCES journal_entries(id) ON DELETE NO ACTION,
    reverses_event_id         uuid REFERENCES shareholder_events(id) ON DELETE NO ACTION,
    source_reference          text CHECK (source_reference IS NULL OR char_length(source_reference) <= 120),
    reason                    text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
    notes                     text CHECK (notes IS NULL OR char_length(notes) <= 2000),
    idempotency_key           text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200),
    idempotency_payload_hash  text CHECK (idempotency_payload_hash IS NULL OR idempotency_payload_hash ~ '^[0-9a-f]{64}$'),
    created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at                timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    FOREIGN KEY (business_id, shareholder_id)
        REFERENCES shareholder_accounts (business_id, id) ON DELETE NO ACTION,
    CHECK ((idempotency_key IS NULL) = (idempotency_payload_hash IS NULL)),
    CHECK (
      (event_type IN ('shareholder_added', 'ownership_changed', 'shareholder_removed', 'ownership_transfer_out', 'ownership_transfer_in')
       AND ownership_percent IS NOT NULL AND amount_rial IS NULL AND capital_class IS NULL
       AND payment_account_id IS NULL AND journal_entry_id IS NULL AND reverses_event_id IS NULL)
      OR
      (event_type IN ('capital_contribution', 'capital_withdrawal', 'capital_reversal')
       AND ownership_percent IS NULL AND transfer_percent IS NULL AND transfer_group_id IS NULL
       AND amount_rial IS NOT NULL AND capital_class IS NOT NULL
       AND payment_account_id IS NOT NULL AND journal_entry_id IS NOT NULL)
    ),
    CHECK (
      (event_type IN ('ownership_transfer_out', 'ownership_transfer_in')) =
      (transfer_group_id IS NOT NULL AND transfer_percent IS NOT NULL)
    ),
    CHECK (
      event_type IN ('ownership_transfer_out', 'ownership_transfer_in')
      OR (transfer_group_id IS NULL AND transfer_percent IS NULL)
    ),
    CHECK ((event_type = 'capital_reversal') = (reverses_event_id IS NOT NULL)),
    CHECK (event_type <> 'shareholder_added' OR ownership_percent > 0),
    CHECK (event_type <> 'shareholder_removed' OR (ownership_percent = 0 AND (share_units IS NULL OR share_units = 0))),
    CHECK (event_type <> 'ownership_transfer_out' OR ownership_percent >= 0),
    CHECK (event_type <> 'ownership_transfer_in' OR ownership_percent > 0)
);
CREATE INDEX idx_shareholder_events_effective
    ON shareholder_events (business_id, shareholder_id, effective_on, created_at, id)
    WHERE ownership_percent IS NOT NULL;
CREATE UNIQUE INDEX uq_shareholder_ownership_event_date
    ON shareholder_events (business_id, shareholder_id, effective_on)
    WHERE ownership_percent IS NOT NULL;
CREATE INDEX idx_shareholder_events_capital_history
    ON shareholder_events (business_id, effective_on DESC, created_at DESC)
    WHERE amount_rial IS NOT NULL;
CREATE UNIQUE INDEX uq_shareholder_events_idempotency
    ON shareholder_events (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_shareholder_event_reversal
    ON shareholder_events (business_id, reverses_event_id)
    WHERE reverses_event_id IS NOT NULL;
CREATE INDEX idx_shareholder_event_journal
    ON shareholder_events (business_id, journal_entry_id)
    WHERE journal_entry_id IS NOT NULL;

CREATE FUNCTION shareholder_event_affinity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    row_business uuid;
    account_business uuid;
    entry_business uuid;
    entry_source text;
    entry_source_id uuid;
    expected_source text;
    actor_business uuid;
BEGIN
    SELECT business_id INTO row_business FROM shareholder_accounts WHERE id = NEW.shareholder_id;
    IF row_business IS NULL OR row_business <> NEW.business_id THEN
        RAISE EXCEPTION 'shareholder_business_mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.payment_account_id IS NOT NULL THEN
        SELECT business_id INTO account_business FROM accounts WHERE id = NEW.payment_account_id;
        IF account_business IS NULL OR account_business <> NEW.business_id THEN
            RAISE EXCEPTION 'shareholder_payment_account_business_mismatch' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.journal_entry_id IS NOT NULL THEN
        expected_source := 'shareholder_event';
        IF NEW.event_type = 'capital_reversal' THEN
            expected_source := 'shareholder_event_reversal';
        END IF;
        SELECT business_id, source_type, source_id
          INTO entry_business, entry_source, entry_source_id
          FROM journal_entries WHERE id = NEW.journal_entry_id;
        IF entry_business IS NULL OR entry_business <> NEW.business_id
           OR entry_source IS DISTINCT FROM expected_source
           OR entry_source_id <> NEW.id THEN
            RAISE EXCEPTION 'shareholder_journal_entry_mismatch' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.reverses_event_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM shareholder_events original
         WHERE original.id = NEW.reverses_event_id
           AND original.business_id = NEW.business_id
           AND original.shareholder_id = NEW.shareholder_id
           AND original.amount_rial = NEW.amount_rial
           AND original.capital_class = NEW.capital_class
           AND original.event_type IN ('capital_contribution', 'capital_withdrawal')
    ) THEN
        RAISE EXCEPTION 'shareholder_reversal_source_mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.created_by IS NOT NULL THEN
        SELECT business_id INTO actor_business FROM users WHERE id = NEW.created_by;
        IF actor_business IS NULL OR actor_business <> NEW.business_id THEN
            RAISE EXCEPTION 'shareholder_event_actor_business_mismatch' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_shareholder_event_affinity
    BEFORE INSERT ON shareholder_events
    FOR EACH ROW EXECUTE FUNCTION shareholder_event_affinity_guard();

CREATE FUNCTION shareholder_event_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'shareholder_events is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_shareholder_events_append_only
    BEFORE UPDATE OR DELETE ON shareholder_events
    FOR EACH ROW EXECUTE FUNCTION shareholder_event_append_only_guard();

-- Same-day multiple snapshots for one holder are ambiguous and rejected by the
-- unique index above. A transfer is a two-party atomic operation; the deferred
-- check guarantees that direct SQL cannot leave only one half of a transfer.
CREATE FUNCTION shareholder_transfer_group_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    transfer_count integer;
    out_count integer;
    in_count integer;
    percent_count integer;
    party_count integer;
BEGIN
    IF NEW.transfer_group_id IS NULL THEN RETURN NEW; END IF;
    SELECT count(*), count(*) FILTER (WHERE event_type = 'ownership_transfer_out'),
           count(*) FILTER (WHERE event_type = 'ownership_transfer_in'),
           count(DISTINCT transfer_percent), count(DISTINCT shareholder_id)
      INTO transfer_count, out_count, in_count, percent_count, party_count
      FROM shareholder_events
     WHERE business_id = NEW.business_id AND transfer_group_id = NEW.transfer_group_id;
    IF transfer_count <> 2 OR out_count <> 1 OR in_count <> 1 OR percent_count <> 1 OR party_count <> 2
       OR EXISTS (
          SELECT 1 FROM shareholder_events
           WHERE business_id = NEW.business_id AND transfer_group_id = NEW.transfer_group_id
           GROUP BY effective_on HAVING count(*) <> 2
       ) THEN
        RAISE EXCEPTION 'shareholder_transfer_pair_invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_shareholder_transfer_group_guard
    AFTER INSERT ON shareholder_events DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION shareholder_transfer_group_guard();

ALTER TABLE shareholder_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE shareholder_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shareholder_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Distributions are immutable snapshots; only the lifecycle columns below may
-- move. Lines freeze the ownership/date/amount used for each allocation.
CREATE TABLE shareholder_distributions (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id               uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    fiscal_year_id            uuid NOT NULL REFERENCES fiscal_years(id) ON DELETE NO ACTION,
    closing_entry_id          uuid NOT NULL REFERENCES journal_entries(id) ON DELETE NO ACTION,
    snapshot_on               date NOT NULL,
    source_profit_rial        bigint NOT NULL CHECK (source_profit_rial > 0),
    tax_adjustment_rial       bigint NOT NULL DEFAULT 0 CHECK (tax_adjustment_rial >= 0),
    reserve_adjustment_rial   bigint NOT NULL DEFAULT 0 CHECK (reserve_adjustment_rial >= 0),
    manual_adjustment_rial    bigint NOT NULL DEFAULT 0,
    adjustment_reason         text CHECK (adjustment_reason IS NULL OR char_length(adjustment_reason) <= 500),
    distributable_rial        bigint NOT NULL CHECK (distributable_rial > 0 AND distributable_rial <= source_profit_rial),
    source_reference          text CHECK (source_reference IS NULL OR char_length(source_reference) <= 120),
    status                    text NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'approved', 'posted', 'partially_paid', 'paid', 'reversed', 'cancelled')),
    posting_entry_id          uuid REFERENCES journal_entries(id) ON DELETE NO ACTION,
    reversal_entry_id         uuid REFERENCES journal_entries(id) ON DELETE NO ACTION,
    created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at                timestamptz NOT NULL DEFAULT now(),
    approved_by               uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at               timestamptz,
    posted_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
    posted_at                 timestamptz,
    reversed_by               uuid REFERENCES users(id) ON DELETE SET NULL,
    reversed_at               timestamptz,
    cancelled_by              uuid REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at              timestamptz,
    cancel_reason             text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 500),
    idempotency_key           text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200),
    idempotency_payload_hash  text CHECK (idempotency_payload_hash IS NULL OR idempotency_payload_hash ~ '^[0-9a-f]{64}$'),
    UNIQUE (business_id, id),
    CHECK ((idempotency_key IS NULL) = (idempotency_payload_hash IS NULL)),
    CHECK (distributable_rial::numeric = source_profit_rial::numeric - tax_adjustment_rial::numeric - reserve_adjustment_rial::numeric + manual_adjustment_rial::numeric),
    CHECK (
      (tax_adjustment_rial = 0 AND reserve_adjustment_rial = 0 AND manual_adjustment_rial = 0)
      OR (adjustment_reason IS NOT NULL AND char_length(btrim(adjustment_reason)) > 0)
    ),
    CHECK ((status IN ('posted', 'partially_paid', 'paid', 'reversed')) = (posting_entry_id IS NOT NULL)),
    CHECK ((status = 'reversed') = (reversal_entry_id IS NOT NULL)),
    CHECK (
      (status = 'cancelled' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
       AND cancel_reason IS NOT NULL AND char_length(btrim(cancel_reason)) > 0)
      OR
      (status <> 'cancelled' AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL)
    )
);
CREATE INDEX idx_shareholder_distributions_fiscal_year
    ON shareholder_distributions (business_id, fiscal_year_id, created_at DESC);
CREATE INDEX idx_shareholder_distributions_status
    ON shareholder_distributions (business_id, status, created_at DESC);
CREATE UNIQUE INDEX uq_shareholder_distributions_idempotency
    ON shareholder_distributions (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE FUNCTION shareholder_distribution_affinity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    year_business uuid;
    year_closed timestamptz;
    year_start date;
    year_end date;
    entry_business uuid;
    entry_source text;
    entry_source_id uuid;
BEGIN
    SELECT business_id, closed_at, starts_on, ends_on
      INTO year_business, year_closed, year_start, year_end
      FROM fiscal_years WHERE id = NEW.fiscal_year_id;
    IF year_business IS NULL OR year_business <> NEW.business_id OR year_closed IS NULL
       OR NEW.snapshot_on < year_start OR NEW.snapshot_on > year_end THEN
        RAISE EXCEPTION 'shareholder_distribution_requires_closed_fiscal_year' USING ERRCODE = '23514';
    END IF;

    SELECT business_id, source_type, source_id
      INTO entry_business, entry_source, entry_source_id
      FROM journal_entries WHERE id = NEW.closing_entry_id;
    IF entry_business IS NULL OR entry_business <> NEW.business_id OR entry_source <> 'closing'
       OR entry_source_id <> NEW.fiscal_year_id THEN
        RAISE EXCEPTION 'shareholder_distribution_closing_source_mismatch' USING ERRCODE = '23514';
    END IF;

    IF NEW.posting_entry_id IS NOT NULL THEN
        SELECT business_id, source_type, source_id
          INTO entry_business, entry_source, entry_source_id
          FROM journal_entries WHERE id = NEW.posting_entry_id;
        IF entry_business IS NULL OR entry_business <> NEW.business_id
           OR entry_source <> 'shareholder_distribution' OR entry_source_id <> NEW.id THEN
            RAISE EXCEPTION 'shareholder_distribution_posting_source_mismatch' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.reversal_entry_id IS NOT NULL THEN
        SELECT business_id, source_type, source_id
          INTO entry_business, entry_source, entry_source_id
          FROM journal_entries WHERE id = NEW.reversal_entry_id;
        IF entry_business IS NULL OR entry_business <> NEW.business_id
           OR entry_source <> 'shareholder_distribution_reversal' OR entry_source_id <> NEW.id THEN
            RAISE EXCEPTION 'shareholder_distribution_reversal_source_mismatch' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1
          FROM unnest(ARRAY[NEW.created_by, NEW.approved_by, NEW.posted_by, NEW.reversed_by, NEW.cancelled_by]::uuid[]) AS actor_ids(actor_id)
          LEFT JOIN users u ON u.id = actor_ids.actor_id
         WHERE actor_ids.actor_id IS NOT NULL
           AND (u.id IS NULL OR u.business_id <> NEW.business_id)
    ) THEN
        RAISE EXCEPTION 'shareholder_distribution_actor_business_mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_shareholder_distribution_affinity
    BEFORE INSERT OR UPDATE ON shareholder_distributions
    FOR EACH ROW EXECUTE FUNCTION shareholder_distribution_affinity_guard();

CREATE FUNCTION shareholder_distribution_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'shareholder_distributions are retained; reverse instead' USING ERRCODE = '55000';
    END IF;
    IF NEW.business_id IS DISTINCT FROM OLD.business_id
       OR NEW.fiscal_year_id IS DISTINCT FROM OLD.fiscal_year_id
       OR NEW.closing_entry_id IS DISTINCT FROM OLD.closing_entry_id
       OR NEW.snapshot_on IS DISTINCT FROM OLD.snapshot_on
       OR NEW.source_profit_rial IS DISTINCT FROM OLD.source_profit_rial
       OR NEW.tax_adjustment_rial IS DISTINCT FROM OLD.tax_adjustment_rial
       OR NEW.reserve_adjustment_rial IS DISTINCT FROM OLD.reserve_adjustment_rial
       OR NEW.manual_adjustment_rial IS DISTINCT FROM OLD.manual_adjustment_rial
       OR NEW.adjustment_reason IS DISTINCT FROM OLD.adjustment_reason
       OR NEW.distributable_rial IS DISTINCT FROM OLD.distributable_rial
       OR NEW.source_reference IS DISTINCT FROM OLD.source_reference
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.idempotency_payload_hash IS DISTINCT FROM OLD.idempotency_payload_hash THEN
        RAISE EXCEPTION 'shareholder_distribution_snapshot_is_immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
          (OLD.status = 'draft' AND NEW.status IN ('approved', 'cancelled')) OR
          (OLD.status = 'approved' AND NEW.status IN ('posted', 'cancelled')) OR
          (OLD.status = 'posted' AND NEW.status IN ('partially_paid', 'paid', 'reversed')) OR
          (OLD.status = 'partially_paid' AND NEW.status IN ('posted', 'paid', 'reversed')) OR
          (OLD.status = 'paid' AND NEW.status IN ('posted', 'partially_paid'))
        ) THEN
            RAISE EXCEPTION 'shareholder_distribution_invalid_transition' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
        IF NOT (OLD.status = 'draft' AND NEW.status = 'approved' AND NEW.approved_by IS NOT NULL AND NEW.approved_at IS NOT NULL) THEN
            RAISE EXCEPTION 'shareholder_distribution_approval_is_immutable' USING ERRCODE = '55000';
        END IF;
    END IF;
    IF NEW.posting_entry_id IS DISTINCT FROM OLD.posting_entry_id OR NEW.posted_by IS DISTINCT FROM OLD.posted_by OR NEW.posted_at IS DISTINCT FROM OLD.posted_at THEN
        IF NOT (OLD.status = 'approved' AND NEW.status = 'posted' AND NEW.posting_entry_id IS NOT NULL AND NEW.posted_by IS NOT NULL AND NEW.posted_at IS NOT NULL) THEN
            RAISE EXCEPTION 'shareholder_distribution_posting_is_immutable' USING ERRCODE = '55000';
        END IF;
    END IF;
    IF NEW.reversal_entry_id IS DISTINCT FROM OLD.reversal_entry_id OR NEW.reversed_by IS DISTINCT FROM OLD.reversed_by OR NEW.reversed_at IS DISTINCT FROM OLD.reversed_at THEN
        IF NOT (NEW.status = 'reversed' AND NEW.reversal_entry_id IS NOT NULL AND NEW.reversed_by IS NOT NULL AND NEW.reversed_at IS NOT NULL) THEN
            RAISE EXCEPTION 'shareholder_distribution_reversal_is_immutable' USING ERRCODE = '55000';
        END IF;
    END IF;
    IF NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason THEN
        IF NOT (
          OLD.status IN ('draft', 'approved') AND NEW.status = 'cancelled'
          AND NEW.cancelled_by IS NOT NULL AND NEW.cancelled_at IS NOT NULL
          AND NEW.cancel_reason IS NOT NULL AND char_length(btrim(NEW.cancel_reason)) > 0
        ) THEN
            RAISE EXCEPTION 'shareholder_distribution_cancellation_is_immutable' USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_shareholder_distribution_immutable
    BEFORE UPDATE OR DELETE ON shareholder_distributions
    FOR EACH ROW EXECUTE FUNCTION shareholder_distribution_immutable_guard();

ALTER TABLE shareholder_distributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shareholder_distributions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shareholder_distributions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE shareholder_distribution_lines (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id          uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    distribution_id      uuid NOT NULL,
    shareholder_id       uuid NOT NULL,
    party_id              uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    ownership_percent     numeric(9,6) NOT NULL CHECK (ownership_percent BETWEEN 0 AND 100),
    share_units           numeric(20,6) CHECK (share_units IS NULL OR share_units >= 0),
    allocated_rial        bigint NOT NULL CHECK (allocated_rial >= 0),
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    UNIQUE (distribution_id, shareholder_id),
    FOREIGN KEY (business_id, distribution_id)
        REFERENCES shareholder_distributions (business_id, id) ON DELETE NO ACTION,
    FOREIGN KEY (business_id, shareholder_id)
        REFERENCES shareholder_accounts (business_id, id) ON DELETE NO ACTION
);
CREATE INDEX idx_shareholder_distribution_lines_party
    ON shareholder_distribution_lines (business_id, party_id, distribution_id);

CREATE FUNCTION shareholder_distribution_line_affinity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    party_business uuid;
    account_party uuid;
BEGIN
    SELECT party_id INTO account_party
      FROM shareholder_accounts WHERE id = NEW.shareholder_id AND business_id = NEW.business_id;
    SELECT business_id INTO party_business FROM parties WHERE id = NEW.party_id;
    IF account_party IS NULL OR account_party <> NEW.party_id OR party_business <> NEW.business_id THEN
        RAISE EXCEPTION 'shareholder_distribution_party_mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_shareholder_distribution_line_affinity
    BEFORE INSERT ON shareholder_distribution_lines
    FOR EACH ROW EXECUTE FUNCTION shareholder_distribution_line_affinity_guard();

CREATE FUNCTION shareholder_distribution_line_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'shareholder_distribution_lines are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_shareholder_distribution_lines_append_only
    BEFORE UPDATE OR DELETE ON shareholder_distribution_lines
    FOR EACH ROW EXECUTE FUNCTION shareholder_distribution_line_append_only_guard();

ALTER TABLE shareholder_distribution_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE shareholder_distribution_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shareholder_distribution_lines FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE FUNCTION shareholder_distribution_total_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    expected bigint;
    actual numeric;
    distribution_id_value uuid;
    business_id_value uuid;
BEGIN
    IF TG_TABLE_NAME = 'shareholder_distributions' THEN
        distribution_id_value := NEW.id;
        business_id_value := NEW.business_id;
    ELSIF TG_OP = 'DELETE' THEN
        distribution_id_value := OLD.distribution_id;
        business_id_value := OLD.business_id;
    ELSE
        distribution_id_value := NEW.distribution_id;
        business_id_value := NEW.business_id;
    END IF;
    SELECT distributable_rial INTO expected FROM shareholder_distributions
     WHERE id = distribution_id_value AND business_id = business_id_value;
    IF expected IS NULL THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;
    SELECT coalesce(sum(allocated_rial), 0)::numeric INTO actual
      FROM shareholder_distribution_lines
     WHERE distribution_id = distribution_id_value AND business_id = business_id_value;
    IF actual <> expected::numeric THEN
        RAISE EXCEPTION 'shareholder_distribution_lines_do_not_balance' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_shareholder_distribution_line_total
    AFTER INSERT ON shareholder_distribution_lines DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION shareholder_distribution_total_guard();
CREATE CONSTRAINT TRIGGER trg_shareholder_distribution_has_lines
    AFTER INSERT ON shareholder_distributions DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION shareholder_distribution_total_guard();

CREATE TABLE shareholder_distribution_events (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    distribution_id uuid NOT NULL,
    event_type      text NOT NULL CHECK (event_type IN ('created', 'approved', 'posted', 'payment', 'payment_reversed', 'reversed', 'cancelled')),
    actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    created_at      timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (business_id, distribution_id)
        REFERENCES shareholder_distributions (business_id, id) ON DELETE NO ACTION
);
CREATE INDEX idx_shareholder_distribution_events
    ON shareholder_distribution_events (business_id, distribution_id, created_at, id);

CREATE FUNCTION shareholder_distribution_event_affinity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    actor_business uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM shareholder_distributions WHERE id = NEW.distribution_id AND business_id = NEW.business_id) THEN
        RAISE EXCEPTION 'shareholder_distribution_event_business_mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.actor_id IS NOT NULL THEN
        SELECT business_id INTO actor_business FROM users WHERE id = NEW.actor_id;
        IF actor_business IS NULL OR actor_business <> NEW.business_id THEN
            RAISE EXCEPTION 'shareholder_distribution_actor_business_mismatch' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_shareholder_distribution_event_affinity
    BEFORE INSERT ON shareholder_distribution_events
    FOR EACH ROW EXECUTE FUNCTION shareholder_distribution_event_affinity_guard();

CREATE FUNCTION shareholder_distribution_event_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'shareholder_distribution_events are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_shareholder_distribution_events_append_only
    BEFORE UPDATE OR DELETE ON shareholder_distribution_events
    FOR EACH ROW EXECUTE FUNCTION shareholder_distribution_event_append_only_guard();

ALTER TABLE shareholder_distribution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE shareholder_distribution_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shareholder_distribution_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Payments are immutable settlements against one frozen line. A returned
-- payment is a second, linked mirror journal; no amount or payment row is
-- overwritten. Idempotency is on the original payment request.
CREATE TABLE shareholder_distribution_payments (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id               uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    distribution_id           uuid NOT NULL,
    distribution_line_id      uuid NOT NULL,
    shareholder_id            uuid NOT NULL,
    party_id                  uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    payment_type              text NOT NULL CHECK (payment_type IN ('payment', 'reversal')),
    paid_on                   date NOT NULL,
    amount_rial               bigint NOT NULL CHECK (amount_rial > 0),
    payment_account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    journal_entry_id          uuid NOT NULL REFERENCES journal_entries(id) ON DELETE NO ACTION,
    reverses_payment_id       uuid REFERENCES shareholder_distribution_payments(id) ON DELETE NO ACTION,
    idempotency_key           text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200),
    idempotency_payload_hash  text CHECK (idempotency_payload_hash IS NULL OR idempotency_payload_hash ~ '^[0-9a-f]{64}$'),
    note                      text CHECK (note IS NULL OR char_length(note) <= 500),
    created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at                timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id),
    FOREIGN KEY (business_id, distribution_id)
        REFERENCES shareholder_distributions (business_id, id) ON DELETE NO ACTION,
    FOREIGN KEY (business_id, distribution_line_id)
        REFERENCES shareholder_distribution_lines (business_id, id) ON DELETE NO ACTION,
    FOREIGN KEY (business_id, shareholder_id)
        REFERENCES shareholder_accounts (business_id, id) ON DELETE NO ACTION,
    CHECK ((idempotency_key IS NULL) = (idempotency_payload_hash IS NULL)),
    CHECK ((payment_type = 'reversal') = (reverses_payment_id IS NOT NULL))
);
CREATE INDEX idx_shareholder_distribution_payments_line
    ON shareholder_distribution_payments (business_id, distribution_line_id, paid_on, created_at);
CREATE UNIQUE INDEX uq_shareholder_distribution_payment_idempotency
    ON shareholder_distribution_payments (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_shareholder_distribution_payment_reversal
    ON shareholder_distribution_payments (business_id, reverses_payment_id)
    WHERE reverses_payment_id IS NOT NULL;

CREATE FUNCTION shareholder_distribution_payment_affinity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    row_business uuid;
    row_party uuid;
    payment_account_business uuid;
    entry_business uuid;
    entry_source text;
    entry_source_id uuid;
    original record;
    expected_source text;
BEGIN
    SELECT d.business_id, l.party_id
      INTO row_business, row_party
      FROM shareholder_distributions d
      JOIN shareholder_distribution_lines l ON l.distribution_id = d.id AND l.business_id = d.business_id
     WHERE d.id = NEW.distribution_id AND d.business_id = NEW.business_id
       AND l.id = NEW.distribution_line_id AND l.shareholder_id = NEW.shareholder_id;
    IF row_business IS NULL OR row_party <> NEW.party_id THEN
        RAISE EXCEPTION 'shareholder_payment_line_mismatch' USING ERRCODE = '23514';
    END IF;
    SELECT business_id INTO payment_account_business FROM accounts WHERE id = NEW.payment_account_id;
    IF payment_account_business IS NULL OR payment_account_business <> NEW.business_id THEN
        RAISE EXCEPTION 'shareholder_payment_account_business_mismatch' USING ERRCODE = '23514';
    END IF;
    expected_source := CASE WHEN NEW.payment_type = 'payment'
        THEN 'shareholder_distribution_payment' ELSE 'shareholder_distribution_payment_reversal' END;
    SELECT business_id, source_type, source_id
      INTO entry_business, entry_source, entry_source_id
      FROM journal_entries WHERE id = NEW.journal_entry_id;
    IF entry_business IS NULL OR entry_business <> NEW.business_id
       OR entry_source <> expected_source OR entry_source_id <> NEW.id THEN
        RAISE EXCEPTION 'shareholder_payment_journal_mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.created_by IS NOT NULL THEN
        SELECT business_id INTO row_business FROM users WHERE id = NEW.created_by;
        IF row_business IS NULL OR row_business <> NEW.business_id THEN
            RAISE EXCEPTION 'shareholder_payment_actor_business_mismatch' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.payment_type = 'reversal' THEN
        SELECT * INTO original FROM shareholder_distribution_payments
         WHERE id = NEW.reverses_payment_id AND business_id = NEW.business_id;
        IF original.id IS NULL OR original.payment_type <> 'payment'
           OR original.distribution_id <> NEW.distribution_id
           OR original.distribution_line_id <> NEW.distribution_line_id
           OR original.amount_rial <> NEW.amount_rial THEN
            RAISE EXCEPTION 'shareholder_payment_reversal_mismatch' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_shareholder_distribution_payment_affinity
    BEFORE INSERT ON shareholder_distribution_payments
    FOR EACH ROW EXECUTE FUNCTION shareholder_distribution_payment_affinity_guard();

CREATE FUNCTION shareholder_distribution_payment_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'shareholder_distribution_payments are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_shareholder_distribution_payments_append_only
    BEFORE UPDATE OR DELETE ON shareholder_distribution_payments
    FOR EACH ROW EXECUTE FUNCTION shareholder_distribution_payment_append_only_guard();

ALTER TABLE shareholder_distribution_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shareholder_distribution_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shareholder_distribution_payments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- For money-moving shareholder entries, every line on a shareholder account
-- must keep its party tag. The general journal remains available for opening
-- and legacy equity lines; this guard is scoped to the domain's immutable source
-- documents only.
CREATE FUNCTION shareholder_journal_party_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    source text;
    account_code text;
    entry_business uuid;
BEGIN
    SELECT je.source_type, je.business_id, a.code
      INTO source, entry_business, account_code
      FROM journal_entries je
      JOIN accounts a ON a.id = NEW.account_id AND a.business_id = je.business_id
     WHERE je.id = NEW.entry_id;
    IF source IN ('shareholder_event', 'shareholder_event_reversal', 'shareholder_distribution',
                  'shareholder_distribution_reversal', 'shareholder_distribution_payment',
                  'shareholder_distribution_payment_reversal')
       AND account_code IN ('2510', '2520', '3100', '3150', '3200', '3800')
       AND (
         NEW.party_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM shareholder_accounts sa
            WHERE sa.business_id = entry_business AND sa.party_id = NEW.party_id
         )
       ) THEN
        RAISE EXCEPTION 'shareholder_journal_party_required' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_shareholder_journal_party
    BEFORE INSERT ON journal_lines
    FOR EACH ROW EXECUTE FUNCTION shareholder_journal_party_guard();

-- The accounting-event identity is cross-business audited like other party
-- references: never move a shareholder account to a different business, even
-- under a tenant bypass.
CREATE INDEX idx_shareholder_distribution_lines_distribution
    ON shareholder_distribution_lines (business_id, distribution_id, shareholder_id);

-- ============================================================================
-- End of 0222.
-- ============================================================================
