-- ---------------------------------------------------------------------------
-- Cheques: canonical instrument identity, retry safety, and the replacement
-- link a returned cheque's resolution needs — issue #828 (6), (7), (11).
-- ---------------------------------------------------------------------------
-- 1. **Identity.** `cheques_unique_serial` compares the serial and the bank
--    exactly as typed, so «۱۲۳۴۵۶» and "123456", "ملت" and "بانک ملت " were
--    four different instruments to the register and two duplicate cheques to
--    the business. Two canonical columns carry the comparable form — Latin
--    digits, no separators, no «بانک » prefix, folded whitespace — and the
--    uniqueness rule moves onto them. The typed values are untouched: they are
--    what is printed on the paper, and the register still shows them.
--
--    The canonical columns are GENERATED, computed by the SQL twin of the
--    TypeScript normaliser (`canonicalBankName`, `canonicalSerialNumber` in
--    src/lib/cheques.ts), so no insert path can forget them. Existing rows can
--    collide under the stricter rule, so the unique index is created only when
--    the data allows it; a tenant carrying real duplicates keeps a
--    non-unique index until those rows are classified.
--
-- 2. **Retry safety.** A money-moving request that is retried after an
--    ambiguous network failure must not post twice. Both cheque tables get the
--    `idempotency_key` column this schema already uses for inventory events,
--    purchase documents and manual-journal drafts (0012/0017/0084), unique per
--    business, so a replay returns the first result instead of a second entry.
--
-- 3. **Replacement link.** A returned cheque resolved by `restore` is usually
--    replaced by a new cheque. Recording which cheque replaced which is what
--    makes the history drillable; it is a pointer, never a posting.

ALTER TABLE cheques
    ADD COLUMN idempotency_key text,
    ADD COLUMN replaces_cheque_id uuid REFERENCES cheques(id) ON DELETE SET NULL;

ALTER TABLE cheque_events
    ADD COLUMN idempotency_key text;

-- The SQL twin of the TypeScript normaliser (`foldForComparison`): Persian and
-- Arabic-Indic digits fold to Latin, the Arabic ي/ك a Persian keyboard
-- produces fold to ی/ک, and every separator and zero-width mark is dropped.
CREATE OR REPLACE FUNCTION public.cheque_canonical_text(raw text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT NULLIF(
        regexp_replace(
            translate(
                lower(btrim(coalesce(raw, ''))),
                '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩يك' || E'\u200b\u200c\u200d\u200e\u200f',
                '01234567890123456789یک'
            ),
            '[[:space:]._/\\-]+', '', 'g'
        ),
        ''
    );
$$;

-- «بانک ملت» and «ملت» are one bank: the prefix is a noun, not a name. It is
-- dropped *after* folding, so the Arabic-kaf spelling loses it too, and only
-- when something is left behind.
--
-- The inner call is schema-qualified on purpose. A generated column re-runs
-- this body whenever a row is written — including inside `pg_restore`, which
-- runs with an empty `search_path`. An unqualified reference resolves at call
-- time and would make every restore of a backup fail with "function
-- cheque_canonical_text(text) does not exist".
CREATE OR REPLACE FUNCTION public.cheque_canonical_bank(raw text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT coalesce(
        NULLIF(regexp_replace(public.cheque_canonical_text(raw), '^بانک', ''), ''),
        public.cheque_canonical_text(raw)
    );
$$;

-- Generated, not written by the application: the canonical form is a fact
-- about the typed text, so it cannot drift from it, cannot be forgotten by a
-- new insert path, and needs no backfill of its own.
ALTER TABLE cheques
    ADD COLUMN bank_name_canonical text
        GENERATED ALWAYS AS (public.cheque_canonical_bank(bank_name)) STORED,
    ADD COLUMN serial_number_canonical text
        GENERATED ALWAYS AS (public.cheque_canonical_text(serial_number)) STORED;

-- The old exact-text rule stays (it is still true), and the canonical rule is
-- added on top where the existing data permits it.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM cheques
         GROUP BY business_id, bank_name_canonical, serial_number_canonical
        HAVING count(*) > 1
    ) THEN
        CREATE UNIQUE INDEX uq_cheques_canonical_serial
            ON cheques (business_id, bank_name_canonical, serial_number_canonical);
    ELSE
        CREATE INDEX uq_cheques_canonical_serial
            ON cheques (business_id, bank_name_canonical, serial_number_canonical);
        RAISE NOTICE 'cheques: canonical serial index created non-unique — existing duplicates need classification';
    END IF;
END;
$$;

CREATE UNIQUE INDEX uq_cheques_idempotency
    ON cheques (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX uq_cheque_events_idempotency
    ON cheque_events (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_cheques_replaces ON cheques (replaces_cheque_id)
    WHERE replaces_cheque_id IS NOT NULL;

-- A replacement must be this business's own cheque: a composite-FK guard, the
-- same shape migration 0210 uses for a fixed asset's acquisition entry.
CREATE OR REPLACE FUNCTION cheque_replacement_affinity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.replaces_cheque_id IS NOT NULL THEN
        IF NEW.replaces_cheque_id = NEW.id THEN
            RAISE EXCEPTION 'a cheque cannot replace itself' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM cheques c
             WHERE c.id = NEW.replaces_cheque_id
               AND c.business_id = NEW.business_id
               AND c.direction = NEW.direction
        ) THEN
            RAISE EXCEPTION 'replaced cheque belongs to another business or direction'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cheque_replacement_affinity
    BEFORE INSERT OR UPDATE OF replaces_cheque_id, business_id, direction ON cheques
    FOR EACH ROW EXECUTE FUNCTION cheque_replacement_affinity();
