-- ---------------------------------------------------------------------------
-- Cheques: make canonical identity enforceable on upgraded data, and make the
-- retry contract compare payloads — issue #828 (6), (7).
-- ---------------------------------------------------------------------------
-- 1. **Uniqueness that upgrades.** Migration 0217 created the canonical index
--    as UNIQUE only when the tenant's existing data happened to allow it, and
--    as a plain index otherwise. That is backwards: the tenant that already
--    has duplicate instruments is exactly the one that needs new writes
--    refused, and the fallback silently left the database with no uniqueness
--    at all — forever, since nothing ever revisited it.
--
--    The rule here keeps legacy rows and still enforces identity for every new
--    write: each colliding group is classified, the earliest row stays the
--    canonical one, every later row is explicitly marked as a known legacy
--    collision (`canonical_duplicate_of` points at the row it duplicates), and
--    the unique index covers the unclassified rows — which is all of them
--    except that recorded legacy. A new registration therefore always collides
--    with the retained row, in the index, inside the transaction, so two
--    concurrent duplicates cannot both commit.
--
--    Classifying is a deliberate act on *existing* financial records, never an
--    escape hatch for new ones: a trigger refuses an INSERT that arrives
--    pre-classified.
--
-- 2. **A retry is the same request, not merely the same key.** 0217 made a
--    repeated `idempotency_key` return the first result. That is only safe
--    when the second request really is a replay; the same key with a different
--    payload is a client bug (or a key collision), and answering it with an
--    unrelated cheque hides the mistake. Both tables now carry the canonical
--    fingerprint of the request that created the row, so a mismatch can be
--    refused instead of silently answered.

ALTER TABLE cheques
    ADD COLUMN idempotency_fingerprint text,
    ADD COLUMN canonical_duplicate_of uuid REFERENCES cheques(id) ON DELETE SET NULL;

ALTER TABLE cheque_events
    ADD COLUMN idempotency_fingerprint text;

COMMENT ON COLUMN cheques.canonical_duplicate_of IS
    'Set only by migration/classification of pre-existing duplicate instruments: the retained cheque this legacy row duplicates. NULL for every cheque written by the application.';

-- Classify what is already there: oldest row of each canonical group is kept,
-- the rest record which row they duplicate.
WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
               PARTITION BY business_id, bank_name_canonical, serial_number_canonical
               ORDER BY created_at, id
           ) AS keeper,
           row_number() OVER (
               PARTITION BY business_id, bank_name_canonical, serial_number_canonical
               ORDER BY created_at, id
           ) AS position
      FROM cheques
)
UPDATE cheques c
   SET canonical_duplicate_of = ranked.keeper
  FROM ranked
 WHERE ranked.id = c.id AND ranked.position > 1;

DROP INDEX IF EXISTS uq_cheques_canonical_serial;

CREATE UNIQUE INDEX uq_cheques_canonical_serial
    ON cheques (business_id, bank_name_canonical, serial_number_canonical)
    WHERE canonical_duplicate_of IS NULL;

-- The classified rows still have to be findable by identity (the register
-- searches and filters on the canonical pair).
CREATE INDEX idx_cheques_canonical_serial_all
    ON cheques (business_id, bank_name_canonical, serial_number_canonical);

CREATE INDEX idx_cheques_canonical_duplicate_of ON cheques (canonical_duplicate_of)
    WHERE canonical_duplicate_of IS NOT NULL;

CREATE OR REPLACE FUNCTION public.cheque_classification_is_not_an_insert_path() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.canonical_duplicate_of IS NOT NULL THEN
        RAISE EXCEPTION 'a new cheque cannot be registered as a legacy canonical duplicate'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cheque_classification_not_on_insert
    BEFORE INSERT ON cheques
    FOR EACH ROW EXECUTE FUNCTION public.cheque_classification_is_not_an_insert_path();
