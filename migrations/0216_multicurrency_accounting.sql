-- ============================================================================
-- 0216_multicurrency_accounting.sql — issue #863: multicurrency accounting.
--
-- Currencies, exchange rates, foreign/base balances and FX, as a *subsystem*
-- layered under the existing base-currency ledger. Nothing here reopens the
-- base-currency invariants of #820/#821/#825/#826/#829: the GL keeps its
-- balanced bigint-Rial lines exactly as they are; what changes is that a
-- journal line may now ALSO carry the foreign amount it was denominated in,
-- and an entry may freeze the rate it converted at.
--
-- THE SHAPE OF THE MODEL
--
--   1. One explicit base currency per business (`businesses.base_currency_code`,
--      default 'IRR' — the platform already stores base money as integer
--      smallest-unit Rial). Every rate is quoted against it, one direction:
--      base minor units per one major unit of the foreign currency.
--
--   2. A global currency catalogue (`currencies` — shared reference data, no
--      RLS, the same treatment as feature_flags) and a per-business set of
--      allowed transaction currencies (`business_currencies`). A document may
--      only be denominated in a currency the business switched on.
--
--   3. `exchange_rates` is append-only and effective-dated: one row per
--      (business, currency, effective instant), guarded against UPDATE and
--      DELETE the way payroll's pay-term history is (cascade deletes from
--      removing a whole business are the one permitted exception). A rate
--      entered in error is *voided* (`exchange_rate_voids`), never edited;
--      every manual rate records who entered it, when, and which earlier rate
--      it supersedes — the audit trail the issue asks for lives in
--      `exchange_rate_changes`, written by the service in the same transaction
--      as the rate it describes.
--
--   4. The journal model grows snapshot columns. A foreign-currency entry
--      carries its transaction currency, the exact rate row AND rate value it
--      used, the base currency it converted into, the rounding policy version,
--      and the base-rial rounding delta it absorbed. Each line then carries
--      the foreign debit/credit (integer minor units — cents for USD) beside
--      the base debit/credit that was always there, plus an optional party for
--      foreign customer/supplier balances. Historical postings never change
--      when rates change, because the snapshot is ON the entry and rates are
--      immutable.
--
--   5. FX posting rules get explicit accounts (seeded into every chart):
--      4930 realized FX gain / 5870 realized FX loss (settlement of foreign
--      A/R and A/P at a later rate) and 4935 unrealized FX gain / 5875
--      unrealized FX loss (optional revaluation). Foreign bank accounts are
--      ordinary chart accounts flagged with `accounts.currency_code`.
--
--   6. Settlements apply foreign payments FIFO against open foreign items
--      (`fx_settlement_applications`) with exact base allocation — the slice
--      that empties a lot takes the lot's whole remaining booked base, so
--      realized gain/loss over a lot's life is exact by construction.
--      Revaluations record what was restated and post the difference through
--      `fx_revaluations`/`fx_revaluation_lines`, idempotently.
--
-- ROUNDING POLICY v1 (stamped as `rounding_version = 1` on every foreign
-- entry): per line, base = round-half-up(foreign × rate ÷ 10^precision); the
-- sub-unit residual is absorbed on the largest converted lines and stamped as
-- `rounding_delta`. The policy lives in src/lib/multicurrency.ts; this
-- migration only stores which version produced each entry, so a future policy
-- change can never rewrite history retroactively.
--
-- Tenant RLS on every new tenant table, in this migration, per CLAUDE.md.
-- Forward-only: additive columns, additive tables, additive accounts.
-- ============================================================================

SELECT set_config('app.rls_bypass', 'on', true);

-- ---------------------------------------------------------------------------
-- 1. The currency catalogue (global reference data)
-- ---------------------------------------------------------------------------
-- Code is the ISO 4217 alphabetic code; precision is the ISO minor-unit
-- exponent. IRR stores precision 0: the platform's base money is integer Rial
-- and no fractional Rial exists in practice (ISO's theoretical 2-dinar
-- subunit has been valueless for decades). Amounts of every currency are
-- stored as integer minor units of THAT currency.

CREATE TABLE currencies (
    code        text PRIMARY KEY,
    name        text NOT NULL,
    symbol      text NOT NULL DEFAULT '',
    precision   smallint NOT NULL DEFAULT 2
                CHECK (precision BETWEEN 0 AND 6),
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO currencies (code, name, symbol, precision) VALUES
    ('IRR', 'ریال ایران',              'ریال',   0),
    ('USD', 'دلار آمریکا',             '$',      2),
    ('EUR', 'یورو',                    '€',      2),
    ('AED', 'درهم امارات',             'د.إ',    2),
    ('TRY', 'لیر ترکیه',               '₺',      2),
    ('GBP', 'پوند انگلستان',           '£',      2),
    ('CHF', 'فرانک سوئیس',             '₣',      2),
    ('CNY', 'یوان چین',                '¥',      2),
    ('JPY', 'ین ژاپن',                 '¥',      0),
    ('SAR', 'ریال عربستان',            'ریال',   2),
    ('QAR', 'ریال قطر',                'ریال',   2),
    ('KWD', 'دینار کویت',              'د.ک',    3),
    ('OMR', 'ریال عمان',               'ر.ع.',   3),
    ('BHD', 'دینار بحرین',             'د.ب',    3),
    ('CAD', 'دلار کانادا',             'C$',     2),
    ('AUD', 'دلار استرالیا',           'A$',     2),
    ('INR', 'روپیه هند',               '₹',      2),
    ('RUB', 'روبل روسیه',              '₽',      2),
    ('IQD', 'دینار عراق',              'د.ع',    0),
    ('AZN', 'منات آذربایجان',          '₼',      2)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The business's base and allowed transaction currencies
-- ---------------------------------------------------------------------------
-- Base is explicit and defaults to IRR — what every business has effectively
-- run on since Phase 7, now written down. Changing it is a settings-level act
-- (the service re-checks the allowed set); historical snapshots are
-- unaffected because each foreign entry names the base it converted INTO.

ALTER TABLE businesses
    ADD COLUMN base_currency_code text NOT NULL DEFAULT 'IRR'
        REFERENCES currencies(code)
        CHECK (base_currency_code <> '' );

-- Allowed transaction currencies. The base needs no row here: a document in
-- the base currency is a plain entry, not a foreign one. Adding/removing rows
-- is how the business switches a currency on or off. (A CHECK cannot reach
-- across to businesses.base_currency_code, so the not-base rule is a trigger
-- below — still a database promise, not just the service's.)
CREATE TABLE business_currencies (
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    currency_code  text NOT NULL REFERENCES currencies(code),
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, currency_code)
);

CREATE FUNCTION business_currencies_not_base_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    row_business_id uuid;
    row_currency    text;
    base_code       text;
BEGIN
    row_business_id := COALESCE(NEW.business_id, OLD.business_id);
    row_currency := COALESCE(NEW.currency_code, OLD.currency_code);
    SELECT base_currency_code INTO base_code
      FROM businesses WHERE id = row_business_id;
    IF row_currency = base_code THEN
        RAISE EXCEPTION 'base_currency_not_a_transaction_currency'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END
$$;
CREATE TRIGGER trg_business_currencies_not_base
    AFTER INSERT OR UPDATE ON business_currencies
    FOR EACH ROW EXECUTE FUNCTION business_currencies_not_base_guard();

ALTER TABLE business_currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_currencies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_currencies FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. Exchange rates — append-only, effective-dated, audited
-- ---------------------------------------------------------------------------
-- One rate per (business, currency, effective instant); `rate` is base minor
-- units per ONE MAJOR unit of the currency ($1 = ۶۰۰٬۰۰۰ ریال → 600000). A
-- single direction kills the multiply-or-divide ambiguity and the
-- triangular-conversion trap. `numeric(26,12)`: 14 integer digits of headroom
-- over any realistic rate, 12 fraction digits for exact cross-rate work.
-- Lookup is "latest row with effective_from ≤ the document's moment, not
-- voided" — resolved once at posting, then frozen onto the entry.

CREATE TABLE exchange_rates (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    currency_code      text NOT NULL REFERENCES currencies(code),
    rate               numeric(26, 12) NOT NULL CHECK (rate > 0),
    effective_from     timestamptz NOT NULL,
    -- 'manual' (entered by an accountant) | 'system' (a feed/import wrote it).
    source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'system')),
    -- The rate this one replaces for the same currency — the audit chain of
    -- manual changes, readable without a companion table.
    supersedes_rate_id uuid REFERENCES exchange_rates(id) ON DELETE SET NULL,
    created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now()
);

-- Two rates effective at the same instant would make an as-of lookup
-- ambiguous, so the instant is unique per currency. The lookup index is the
-- DESC companion the "latest ≤ moment" query walks.
CREATE UNIQUE INDEX uq_exchange_rates_effective
    ON exchange_rates (business_id, currency_code, effective_from);
CREATE INDEX idx_exchange_rates_lookup
    ON exchange_rates (business_id, currency_code, effective_from DESC);

-- Append-only, with the same cascade exception as payroll's pay-term history.
CREATE FUNCTION exchange_rates_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'exchange_rates is append-only'
        USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER trg_exchange_rates_guard
    BEFORE UPDATE OR DELETE ON exchange_rates
    FOR EACH ROW EXECUTE FUNCTION exchange_rates_guard();

ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exchange_rates FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- A rate entered in error is voided, not deleted: the void is its own
-- append-only row, so "who corrected it, when, and why" is answerable for
-- ever. Rate lookups skip voided rows.
CREATE TABLE exchange_rate_voids (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- CASCADE: the row's only deletion path is the rate row going away, and
    -- that only happens inside a whole-business teardown (the guard trigger
    -- refuses direct rate deletes), where the void must go with it.
    rate_id      uuid NOT NULL REFERENCES exchange_rates(id) ON DELETE CASCADE,
    voided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    voided_at    timestamptz NOT NULL DEFAULT now(),
    reason       text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
    UNIQUE (rate_id)
);

ALTER TABLE exchange_rate_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rate_voids FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exchange_rate_voids FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- The audit trail for manual rate changes: one row per recorded rate (old
-- effective value → new) and per void. Written by the service in the same
-- transaction as the change it describes; append-only like the rates.
CREATE TABLE exchange_rate_changes (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id          uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    currency_code        text NOT NULL,
    action               text NOT NULL CHECK (action IN ('record', 'void')),
    -- 'record': the previous effective rate's value (NULL when this is the
    -- currency's first rate) and the new row's value.
    -- Canonical rate TEXT, same rule as the entry snapshot: what the actor
    -- recorded, verbatim — numeric::text would pad to scale 12.
    old_rate             text,
    new_rate             text,
    new_effective_from   timestamptz,
    rate_id              uuid,
    -- 'void': which rate row was voided and what it said.
    voided_rate_id       uuid,
    voided_rate_value    numeric(26, 12),
    reason               text,
    actor_id             uuid REFERENCES users(id) ON DELETE SET NULL,
    acted_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT exchange_rate_changes_shape CHECK (
        (action = 'record' AND rate_id IS NOT NULL AND new_rate IS NOT NULL AND new_effective_from IS NOT NULL)
        OR (action = 'void' AND voided_rate_id IS NOT NULL AND voided_rate_value IS NOT NULL)
    )
);

CREATE INDEX idx_exchange_rate_changes_business
    ON exchange_rate_changes (business_id, currency_code, acted_at DESC);

CREATE TRIGGER trg_exchange_rate_changes_guard
    BEFORE UPDATE OR DELETE ON exchange_rate_changes
    FOR EACH ROW EXECUTE FUNCTION exchange_rates_guard();

ALTER TABLE exchange_rate_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rate_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exchange_rate_changes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 4. Foreign-currency financial accounts
-- ---------------------------------------------------------------------------
-- A bank/financial account maintained in a foreign currency is an ordinary
-- chart account that NAMES its currency (NULL = the base currency, every
-- account today). The flag is what the exposure/foreign-bank reports group
-- by, and what the posting service checks a foreign document's lines against.

ALTER TABLE accounts
    ADD COLUMN currency_code text REFERENCES currencies(code);

-- ---------------------------------------------------------------------------
-- 5. The journal model's multicurrency snapshot
-- ---------------------------------------------------------------------------
-- Entry-level: which currency, which rate (row id AND value — the row is the
-- provenance, the value is the self-describing truth that survives even a
-- hypothetical rate-row loss), which base, which rounding policy, how much
-- rounding the document absorbed. NULL currency = a base-only entry, exactly
-- every entry posted before this migration (backfilled by the defaults).

ALTER TABLE journal_entries
    ADD COLUMN currency_code      text REFERENCES currencies(code),
    ADD COLUMN base_currency_code text NOT NULL DEFAULT 'IRR'
        REFERENCES currencies(code),
    ADD COLUMN exchange_rate_id   uuid REFERENCES exchange_rates(id) ON DELETE CASCADE,
    -- The snapshot is the canonical rate TEXT, not a numeric: the value the
    -- document was booked at, verbatim as recorded and self-describing without
    -- scale padding (numeric(26,12)::text would read 600000.000000000000).
    ADD COLUMN exchange_rate      text
        CHECK (exchange_rate IS NULL OR exchange_rate ~ '^(0|[1-9]\d*)(\.\d{1,12})?$'),
    ADD COLUMN rounding_version   smallint,
    ADD COLUMN rounding_delta     bigint NOT NULL DEFAULT 0,
    ADD COLUMN idempotency_key    text;

-- A foreign entry carries a COMPLETE snapshot; a base entry carries none.
-- (rounding_delta stays 0 on base entries — only a converted document has
-- anything to absorb.)
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_currency_snapshot
    CHECK (
        (
            currency_code IS NULL
            AND exchange_rate_id IS NULL
            AND exchange_rate IS NULL
            AND rounding_version IS NULL
            AND rounding_delta = 0
        ) OR (
            currency_code IS NOT NULL
            AND currency_code <> base_currency_code
            AND exchange_rate_id IS NOT NULL
            AND exchange_rate IS NOT NULL
            AND rounding_version IS NOT NULL
            AND rounding_version >= 1
        )
    );

-- Idempotent posting: a retried document returns the entry it already created
-- instead of posting twice. Partial, so pre-existing rows and callers that
-- never send a key are unaffected — the same shape the manual journal and
-- payroll runs already use.
CREATE UNIQUE INDEX uq_journal_entries_idempotency
    ON journal_entries (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_journal_entries_currency
    ON journal_entries (business_id, currency_code, entry_date)
    WHERE currency_code IS NOT NULL;

-- Line-level: the foreign side of each leg (integer minor units of the
-- entry's transaction currency), and the party a foreign receivable/payable
-- belongs to. Defaults keep every pre-existing line exactly as it was.
ALTER TABLE journal_lines
    ADD COLUMN foreign_debit  bigint NOT NULL DEFAULT 0 CHECK (foreign_debit >= 0),
    ADD COLUMN foreign_credit bigint NOT NULL DEFAULT 0 CHECK (foreign_credit >= 0),
    ADD COLUMN party_id       uuid REFERENCES parties(id) ON DELETE SET NULL;

-- The line's shape widens with the foreign side: it must move SOMETHING —
-- base xor base (unchanged for every legacy line), or a foreign side with a
-- zero booked base (the FX-dust line whose base value rounds away to nothing
-- while its foreign leg still moves value between accounts). Both base sides
-- nonzero stays forbidden. (The integration suite caught the original
-- debit-xor-credit rejecting exactly that dust line.)
ALTER TABLE journal_lines DROP CONSTRAINT journal_lines_debit_xor_credit;
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_debit_xor_credit
    CHECK ((debit = 0 OR credit = 0)
           AND (debit <> 0 OR credit <> 0 OR foreign_debit <> 0 OR foreign_credit <> 0));

CREATE INDEX idx_journal_lines_party
    ON journal_lines (party_id)
    WHERE party_id IS NOT NULL;
CREATE INDEX idx_journal_lines_entry_foreign
    ON journal_lines (entry_id)
    WHERE foreign_debit <> 0 OR foreign_credit <> 0;

-- The foreign side's shape, as a deferred constraint trigger (it needs the
-- entry's currency, and it must see all sibling lines before judging the
-- entry's foreign balance):
--   • on a base entry, a line may not carry foreign amounts at all;
--   • on a foreign entry, a line is EITHER a foreign leg (foreign debit XOR
--     foreign credit) OR a base-only leg (both foreign zero — the realized/
--     unrealized FX lines, which exist in base only);
--   • the entry balances in foreign exactly as it (already, app-enforced)
--     balances in base.
-- Deferred so the whole document lands before the check runs, mirroring the
-- app-layer balance check's point of view. Base-side balance stays where it
-- has always been — the posting services — untouched by this issue.
CREATE FUNCTION journal_line_foreign_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    entry_currency text;
    foreign_debit  bigint;
    foreign_credit bigint;
BEGIN
    SELECT currency_code INTO entry_currency
      FROM journal_entries WHERE id = NEW.entry_id;
    IF entry_currency IS NULL THEN
        IF NEW.foreign_debit <> 0 OR NEW.foreign_credit <> 0 THEN
            RAISE EXCEPTION 'foreign_amount_on_base_entry'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.foreign_debit <> 0 AND NEW.foreign_credit <> 0 THEN
        RAISE EXCEPTION 'foreign_line_has_both_sides'
            USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(sum(jl.foreign_debit), 0), coalesce(sum(jl.foreign_credit), 0)
      INTO foreign_debit, foreign_credit
      FROM journal_lines jl WHERE jl.entry_id = NEW.entry_id;
    IF foreign_debit <> foreign_credit THEN
        RAISE EXCEPTION 'foreign_side_unbalanced (% <> %)', foreign_debit, foreign_credit
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER trg_journal_line_foreign_guard
    AFTER INSERT OR UPDATE ON journal_lines
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION journal_line_foreign_guard();

-- Posted financial facts are immutable: the money, the currency and the rate
-- snapshot on an entry/line can never be edited after the fact. Corrections
-- are reversals (append-only, the manual journal's own discipline). The
-- reversal/approval stamps that legitimately UPDATE journal_entries touch
-- other columns and pass.
CREATE FUNCTION journal_immutable_columns_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
           OR NEW.idempotency_key  IS DISTINCT FROM OLD.idempotency_key THEN
            RAISE EXCEPTION 'journal entry financial facts are immutable'
                USING ERRCODE = '55000';
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.entry_id        IS DISTINCT FROM OLD.entry_id
           OR NEW.account_id   IS DISTINCT FROM OLD.account_id
           OR NEW.debit        IS DISTINCT FROM OLD.debit
           OR NEW.credit       IS DISTINCT FROM OLD.credit
           OR NEW.foreign_debit  IS DISTINCT FROM OLD.foreign_debit
           OR NEW.foreign_credit IS DISTINCT FROM OLD.foreign_credit
           OR NEW.party_id       IS DISTINCT FROM OLD.party_id THEN
            RAISE EXCEPTION 'journal line financial facts are immutable'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER trg_journal_entries_immutable
    BEFORE UPDATE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION journal_immutable_columns_guard();
CREATE TRIGGER trg_journal_lines_immutable
    BEFORE UPDATE ON journal_lines
    FOR EACH ROW EXECUTE FUNCTION journal_immutable_columns_guard();

-- ---------------------------------------------------------------------------
-- 6. FX accounts in the chart of accounts
-- ---------------------------------------------------------------------------
-- Realized = settlement of a foreign receivable/payable at a later rate.
-- Unrealized = the optional revaluation. Placement follows 0094's pattern:
-- losses under the financial-expense neighbourhood (58xx), gains directly
-- under the revenue root. Both parents are the type roots every chart has,
-- so the backfill reaches every business — including the two industries whose
-- template never carried 4900 «سایر درآمدها». Well-known in code (never
-- archived from under a posting) and additive/idempotent here.

INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
CROSS JOIN (VALUES
    ('4930', 'سود تسعیر ارز (تحقق‌یافته)',                 'revenue',  '4000'),
    ('4935', 'سود تسعیر تسویه‌نشده ارز (تحقق‌نیافته)',      'revenue',  '4000'),
    ('5870', 'زیان تسعیر ارز (تحقق‌یافته)',                'expense',  '5000'),
    ('5875', 'زیان تسعیر تسویه‌نشده ارز (تحقق‌نیافته)',     'expense',  '5000')
) v(code, name, type, parent)
JOIN accounts p ON p.business_id = b.id AND p.code = v.parent
ON CONFLICT (business_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7. Settlement applications — the exact foreign A/R & A/P subledger
-- ---------------------------------------------------------------------------
-- Open foreign items are journal lines: on the A/R or A/P account, on a
-- foreign-currency entry, attributed to a party. A settlement consumes them
-- FIFO and records what it took — which line, how much foreign value, at what
-- booked base value. Append-only like everything else here: a settlement is
-- corrected by reversing it, and its applications go with it.
--
-- The "base_applied of the lot-emptying slice takes the lot's remainder" rule
-- lives in src/lib/multicurrency.ts; this table is where the truth lands, so
-- «این فاکتور چقدرش تسویه شده» is a query, not a reconstruction.

CREATE TABLE fx_settlement_applications (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id          uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    settlement_entry_id  uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    -- The open item consumed. RESTRICT: an invoice's lines are immutable
    -- financial facts; removing them would orphan the settlement history.
    lot_entry_id         uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
    lot_line_id          bigint NOT NULL REFERENCES journal_lines(id) ON DELETE RESTRICT,
    direction            text NOT NULL CHECK (direction IN ('receivable', 'payable')),
    currency_code        text NOT NULL REFERENCES currencies(code),
    party_id             uuid REFERENCES parties(id) ON DELETE SET NULL,
    foreign_applied      bigint NOT NULL CHECK (foreign_applied > 0),
    base_applied         bigint NOT NULL CHECK (base_applied >= 0),
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fx_settlement_applications_lot
    ON fx_settlement_applications (business_id, lot_line_id);
CREATE INDEX idx_fx_settlement_applications_settlement
    ON fx_settlement_applications (business_id, settlement_entry_id);
CREATE INDEX idx_fx_settlement_applications_party
    ON fx_settlement_applications (business_id, direction, currency_code, party_id);

ALTER TABLE fx_settlement_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_settlement_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fx_settlement_applications FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 8. Unrealized revaluation runs
-- ---------------------------------------------------------------------------
-- Optional. One run restates every foreign-currency account of one currency
-- at one rate, as of one date, and posts the difference through 4935/5875.
-- Each run's entry is linked and idempotent (the shared
-- business/source/posting-kind index), and the per-account figures are kept
-- so «این ارزش‌گذاری چی را تغییر داد» stays answerable without replaying
-- anything. Because the restatement compares the account's *current book
-- base* (which already includes earlier revaluations) against the new rate,
-- runs compose without reversal entries.

CREATE TABLE fx_revaluations (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    currency_code    text NOT NULL REFERENCES currencies(code),
    as_of            date NOT NULL,
    rate_id          uuid NOT NULL REFERENCES exchange_rates(id) ON DELETE CASCADE,
    -- Same canonical-text snapshot rule as journal_entries.exchange_rate.
    rate             text NOT NULL
                     CHECK (rate ~ '^(0|[1-9]\d*)(\.\d{1,12})?$'),
    rounding_version smallint NOT NULL CHECK (rounding_version >= 1),
    total_gain       bigint NOT NULL DEFAULT 0 CHECK (total_gain >= 0),
    total_loss       bigint NOT NULL DEFAULT 0 CHECK (total_loss >= 0),
    entry_id         uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    idempotency_key  text,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_fx_revaluations_idempotency
    ON fx_revaluations (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_fx_revaluations_history
    ON fx_revaluations (business_id, currency_code, as_of DESC, created_at DESC);

CREATE TABLE fx_revaluation_lines (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    revaluation_id    uuid NOT NULL REFERENCES fx_revaluations(id) ON DELETE CASCADE,
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    foreign_balance   bigint NOT NULL,
    book_base_balance bigint NOT NULL,
    new_base_value    bigint NOT NULL,
    -- Signed, asset-normal: positive = the account's base value rose.
    difference        bigint NOT NULL,
    UNIQUE (revaluation_id, account_id)
);

CREATE INDEX idx_fx_revaluation_lines_business
    ON fx_revaluation_lines (business_id, account_id);

ALTER TABLE fx_revaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_revaluations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fx_revaluations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE fx_revaluation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_revaluation_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fx_revaluation_lines FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

SELECT set_config('app.rls_bypass', '', true);
