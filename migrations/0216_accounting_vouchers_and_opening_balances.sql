-- Issue #867 — formal accounting vouchers, fiscal opening balances and carry-forward.
--
-- Three things, each for a different reason:
--
--  1. Every journal entry gets a stable, fiscal-year scoped voucher number
--     (`JV-<jalali year>-<6 digits>`), assigned by the database itself rather
--     than by whichever service remembered to ask. A posting path that forgot
--     the number would otherwise leave a document nobody could cite. The
--     sequence is a row per (business, Jalali year) incremented under the row
--     lock, so a rolled-back posting gives its number back: the numbering gap
--     report can therefore only show numbers removed *after* posting.
--
--  2. Renumbering and reference numbers are the only way to change a voucher's
--     identity. A trigger refuses every other UPDATE to those columns, and the
--     privileged path sets a transaction-local flag. Every such change writes
--     an append-only audit row in the same transaction.
--
--  3. Opening balances become a first-class workflow: a set of balance-sheet
--     lines (never revenue or expense) for one fiscal year, drafted, reviewed,
--     approved and then posted as ONE ordinary journal entry. The posted lines
--     remember the journal line they became, so A/R and A/P attribution
--     survives into the subledgers. Nothing here is a second ledger: the
--     journal stays the only truth, and the set is the controlled proposal
--     that produced a slice of it.
--
-- The Jalali year is computed in SQL by a faithful port of the jalaali-js
-- algorithm that src/lib/jalali.ts uses. A test compares the two over a long
-- date range, because a voucher year that disagreed with the fiscal year the
-- UI shows would be a document filed under the wrong year.

-- ---------------------------------------------------------------------------
-- 1. Jalali year in SQL (the twin of toJalali(...).jy in src/lib/jalali.ts)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_gregorian_jdn(gy integer, gm integer, gd integer)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
    SELECT (((gy + (gm - 8) / 6 + 100100) * 1461) / 4)
         + ((153 * ((gm + 9) % 12) + 2) / 5)
         + gd - 34840408
         - (((gy + 100100 + (gm - 8) / 6) / 100) * 3) / 4 + 752
$$;

CREATE OR REPLACE FUNCTION app_jalali_year(d date) RETURNS integer
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    -- The 33-year-cycle break points, identical to BREAKS in src/lib/jalali.ts.
    breaks   integer[] := ARRAY[-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181,
                                1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394,
                                2456, 3178];
    gy       integer;
    jy0      integer;
    jp       integer;
    jump     integer := 0;
    jm       integer;
    n        integer;
    leap_j   integer := -14;
    leap_g   integer;
    march    integer;
    jdn      integer;
    i        integer;
BEGIN
    IF d IS NULL THEN RETURN NULL; END IF;
    gy  := extract(year FROM d)::integer;
    jdn := app_gregorian_jdn(gy, extract(month FROM d)::integer, extract(day FROM d)::integer);

    -- The candidate Jalali year is gy - 621; the year turns over at Nowruz,
    -- whose Gregorian day in March comes from the leap-year cycle below.
    jy0 := gy - 621;
    IF jy0 < breaks[1] OR jy0 >= breaks[20] THEN RETURN NULL; END IF;

    jp := breaks[1];
    FOR i IN 2..20 LOOP
        jm := breaks[i];
        jump := jm - jp;
        EXIT WHEN jy0 < jm;
        leap_j := leap_j + (jump / 33) * 8 + ((jump % 33) / 4);
        jp := jm;
    END LOOP;
    n := jy0 - jp;
    leap_j := leap_j + (n / 33) * 8 + (((n % 33) + 3) / 4);
    IF (jump % 33) = 4 AND jump - n = 4 THEN leap_j := leap_j + 1; END IF;
    leap_g := (gy / 4) - (((gy / 100) + 1) * 3) / 4 - 150;
    march := 20 + leap_j - leap_g;

    IF jdn >= app_gregorian_jdn(gy, 3, march) THEN
        RETURN jy0;
    END IF;
    RETURN jy0 - 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Voucher numbering
-- ---------------------------------------------------------------------------

CREATE TABLE accounting_voucher_sequences (
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    voucher_year integer NOT NULL,
    last_number  bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
    PRIMARY KEY (business_id, voucher_year)
);

ALTER TABLE accounting_voucher_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_voucher_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounting_voucher_sequences FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE journal_entries
    ADD COLUMN voucher_year      integer,
    ADD COLUMN voucher_number    bigint,
    ADD COLUMN voucher_no        text,
    -- The optional, controlled reference: a number the business already prints
    -- on its paper (a bank slip, an external invoice). Never a substitute for
    -- voucher_no, which stays the system's identity for the document.
    ADD COLUMN external_reference text
        CHECK (external_reference IS NULL OR length(btrim(external_reference)) BETWEEN 1 AND 60);

-- Backfill, in the order the books were actually written: the document's own
-- date, then when it was recorded, then id as the tie-break that makes the
-- sequence deterministic from one run to the next.
UPDATE journal_entries SET voucher_year = app_jalali_year(entry_date);

WITH numbered AS (
    SELECT id,
           row_number() OVER (PARTITION BY business_id, voucher_year
                              ORDER BY entry_date, posted_at, id) AS n
      FROM journal_entries
)
UPDATE journal_entries je
   SET voucher_number = numbered.n
  FROM numbered
 WHERE je.id = numbered.id;

UPDATE journal_entries
   SET voucher_no = 'JV-' || voucher_year || '-' || lpad(voucher_number::text, 6, '0');

INSERT INTO accounting_voucher_sequences (business_id, voucher_year, last_number)
SELECT business_id, voucher_year, max(voucher_number)
  FROM journal_entries
 GROUP BY business_id, voucher_year;

ALTER TABLE journal_entries
    ALTER COLUMN voucher_year SET NOT NULL,
    ALTER COLUMN voucher_number SET NOT NULL,
    ALTER COLUMN voucher_no SET NOT NULL;

CREATE UNIQUE INDEX uq_journal_entries_voucher_number
    ON journal_entries (business_id, voucher_year, voucher_number);
CREATE UNIQUE INDEX uq_journal_entries_external_reference
    ON journal_entries (business_id, external_reference)
    WHERE external_reference IS NOT NULL;

CREATE OR REPLACE FUNCTION assign_journal_voucher_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_year integer;
    v_next bigint;
BEGIN
    v_year := app_jalali_year(NEW.entry_date);
    IF v_year IS NULL THEN
        RAISE EXCEPTION 'voucher_date_out_of_range' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.voucher_year IS NOT NULL AND NEW.voucher_year <> v_year THEN
        RAISE EXCEPTION 'voucher_year_mismatch' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.voucher_number IS NULL THEN
        INSERT INTO accounting_voucher_sequences (business_id, voucher_year, last_number)
        VALUES (NEW.business_id, v_year, 1)
        ON CONFLICT (business_id, voucher_year)
        DO UPDATE SET last_number = accounting_voucher_sequences.last_number + 1
        RETURNING last_number INTO v_next;
        NEW.voucher_number := v_next;
    ELSE
        -- A document that already carries its number (a restore, an import)
        -- keeps it, and the sequence is moved past it so it is never re-issued.
        INSERT INTO accounting_voucher_sequences (business_id, voucher_year, last_number)
        VALUES (NEW.business_id, v_year, NEW.voucher_number)
        ON CONFLICT (business_id, voucher_year)
        DO UPDATE SET last_number = GREATEST(accounting_voucher_sequences.last_number,
                                             EXCLUDED.last_number);
    END IF;

    NEW.voucher_year := v_year;
    NEW.voucher_no := 'JV-' || v_year || '-' || lpad(NEW.voucher_number::text, 6, '0');
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_assign_journal_voucher_identity
    BEFORE INSERT ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION assign_journal_voucher_identity();

-- The identity guard is created after the backfill above, which has to update
-- the very columns it protects.
CREATE OR REPLACE FUNCTION guard_journal_voucher_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.voucher_year, NEW.voucher_number, NEW.voucher_no, NEW.external_reference)
       IS DISTINCT FROM
       (OLD.voucher_year, OLD.voucher_number, OLD.voucher_no, OLD.external_reference)
    THEN
        IF coalesce(current_setting('app.voucher_identity_change', true), '') <> 'on' THEN
            RAISE EXCEPTION 'voucher_identity_locked' USING ERRCODE = 'P0001';
        END IF;
        -- The privileged path may renumber, but never inside a locked period:
        -- the period-lock trigger does not watch these columns, so the check is
        -- made here, where no caller can route around it.
        IF EXISTS (
            SELECT 1 FROM fiscal_periods fp
             WHERE fp.business_id = OLD.business_id
               AND OLD.entry_date BETWEEN fp.starts_on AND fp.ends_on
               AND fp.status = 'locked'
        ) THEN
            RAISE EXCEPTION 'fiscal_period_locked' USING ERRCODE = 'P0001';
        END IF;
    END IF;
    -- Retiming a document across a Jalali year would file it under a number
    -- from another year. Refuse it outright; the entry is never rewritten.
    IF NEW.entry_date IS DISTINCT FROM OLD.entry_date
       AND app_jalali_year(NEW.entry_date) IS DISTINCT FROM OLD.voucher_year THEN
        RAISE EXCEPTION 'voucher_year_change_forbidden' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_journal_voucher_identity
    BEFORE UPDATE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION guard_journal_voucher_identity();

-- Who changed a voucher's identity, when, from what, and why. Append-only, and
-- deliberately without a foreign key to journal_entries: the audit has to
-- outlive any document it describes.
CREATE TABLE journal_voucher_audit (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    entry_id            uuid NOT NULL,
    action              text NOT NULL CHECK (action IN ('renumber', 'reference')),
    voucher_year        integer NOT NULL,
    from_voucher_number bigint,
    to_voucher_number   bigint,
    from_voucher_no     text,
    to_voucher_no       text,
    from_reference      text,
    to_reference        text,
    reason              text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
    actor_id            uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_journal_voucher_audit_entry ON journal_voucher_audit (business_id, entry_id, created_at);

CREATE OR REPLACE FUNCTION journal_voucher_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'journal_voucher_audit_is_append_only' USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER trg_journal_voucher_audit_append_only
    BEFORE UPDATE OR DELETE ON journal_voucher_audit
    FOR EACH ROW EXECUTE FUNCTION journal_voucher_audit_append_only();

ALTER TABLE journal_voucher_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_voucher_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journal_voucher_audit FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. Opening balances and carry-forward
-- ---------------------------------------------------------------------------

CREATE TABLE opening_balance_sets (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    fiscal_year_id        uuid NOT NULL,
    -- 'opening': entered by hand; 'carry_forward': generated from a closed year.
    kind                  text NOT NULL CHECK (kind IN ('opening', 'carry_forward')),
    source_fiscal_year_id uuid,
    effective_date        date NOT NULL,
    status                text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'in_review', 'approved', 'posted', 'reversed')),
    memo                  text NOT NULL DEFAULT '',
    idempotency_key       text CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 1 AND 200),
    journal_entry_id      uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    reversal_entry_id     uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    proposed_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    proposed_at           timestamptz,
    approved_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at           timestamptz,
    last_rejected_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    last_rejected_at      timestamptz,
    last_rejection_reason text,
    posted_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    posted_at             timestamptz,
    reversed_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    reversed_at           timestamptz,
    reversal_reason       text,
    created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (fiscal_year_id, business_id)
        REFERENCES fiscal_years (id, business_id) ON DELETE RESTRICT,
    FOREIGN KEY (source_fiscal_year_id, business_id)
        REFERENCES fiscal_years (id, business_id) ON DELETE RESTRICT,
    CONSTRAINT opening_sets_source_matches_kind
        CHECK ((kind = 'carry_forward') = (source_fiscal_year_id IS NOT NULL)),
    -- An opening set that is posted owns a journal entry. A carry-forward is an
    -- accepted, reconciled register only: the ledger already carries the balances
    -- into the next year, so it never posts a second copy of them.
    CONSTRAINT opening_sets_posted_has_entry
        CHECK (status NOT IN ('posted', 'reversed') OR kind = 'carry_forward' OR journal_entry_id IS NOT NULL),
    CONSTRAINT opening_sets_carry_forward_has_no_entry
        CHECK (kind = 'opening' OR journal_entry_id IS NULL),
    CONSTRAINT opening_sets_reversed_has_reversal
        CHECK (status <> 'reversed' OR reversal_entry_id IS NOT NULL)
);

-- One carry-forward proposal per target year: a retry returns the one that
-- exists instead of generating a second.
CREATE UNIQUE INDEX uq_opening_sets_carry_forward
    ON opening_balance_sets (business_id, fiscal_year_id) WHERE kind = 'carry_forward';
CREATE UNIQUE INDEX uq_opening_sets_idempotency
    ON opening_balance_sets (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- At most one live opening per fiscal year. Two posted sets would double the
-- year's opening position, and the database is the place that can say no to it.
CREATE UNIQUE INDEX uq_opening_sets_one_posted_per_year
    ON opening_balance_sets (business_id, fiscal_year_id) WHERE status = 'posted';
CREATE INDEX idx_opening_sets_business_year ON opening_balance_sets (business_id, fiscal_year_id, status);

CREATE TABLE opening_balance_lines (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id              uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    set_id                   uuid NOT NULL REFERENCES opening_balance_sets(id) ON DELETE CASCADE,
    line_no                  integer NOT NULL CHECK (line_no > 0),
    account_id               uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    -- Integer Rial, like every money column: exactly one side is non-zero.
    debit                    bigint NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit                   bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
    provenance               text NOT NULL DEFAULT 'gl' CHECK (provenance IN (
        'gl', 'cash_bank', 'ar', 'ap', 'cheque', 'inventory', 'fixed_asset', 'equity', 'other')),
    -- Party attribution. The id spaces are the ones the subledgers already use:
    -- A/R counts a party (customers are parties), A/P counts a branch supplier alias.
    customer_id              uuid REFERENCES parties(id) ON DELETE SET NULL,
    supplier_id              uuid REFERENCES suppliers(id) ON DELETE SET NULL,
    source_ref               text CHECK (source_ref IS NULL OR length(btrim(source_ref)) BETWEEN 1 AND 300),
    -- The journal lines this row became when the set was posted, and the lines
    -- its reversal wrote. Subledger attribution joins on these two columns.
    journal_line_id          bigint REFERENCES journal_lines(id) ON DELETE SET NULL,
    reversal_journal_line_id bigint REFERENCES journal_lines(id) ON DELETE SET NULL,
    CONSTRAINT opening_lines_one_side CHECK ((debit = 0) <> (credit = 0)),
    CONSTRAINT opening_lines_one_party CHECK (customer_id IS NULL OR supplier_id IS NULL),
    UNIQUE (set_id, line_no)
);
CREATE INDEX idx_opening_lines_set ON opening_balance_lines (set_id);
CREATE UNIQUE INDEX uq_opening_lines_journal_line
    ON opening_balance_lines (journal_line_id) WHERE journal_line_id IS NOT NULL;
CREATE UNIQUE INDEX uq_opening_lines_reversal_line
    ON opening_balance_lines (reversal_journal_line_id) WHERE reversal_journal_line_id IS NOT NULL;
CREATE INDEX idx_opening_lines_customer ON opening_balance_lines (business_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_opening_lines_supplier ON opening_balance_lines (business_id, supplier_id) WHERE supplier_id IS NOT NULL;

ALTER TABLE opening_balance_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE opening_balance_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON opening_balance_sets FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE opening_balance_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE opening_balance_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON opening_balance_lines FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
