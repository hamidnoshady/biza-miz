-- ---------------------------------------------------------------------------
-- Cheques: durable replay results, and numeric separators folded out of the
-- canonical serial — issue #828 follow-up (3) and (6).
-- ---------------------------------------------------------------------------
-- 1. **A replay must answer with the first call's result, not today's state.**
--    0218 made a repeated key prove it carried the same payload, but the
--    answer was still read from the live row. So a create whose response was
--    lost, retried after the cheque had been deposited and bounced, replied
--    `bounced` — a different answer to the same request, and one the caller
--    would reasonably store as "the cheque I just registered". The same was
--    true of a transition: the retry re-read the cheque, which later steps had
--    already moved on.
--
--    The fix is the ordinary one: keep the result. Each row that owns an
--    idempotency key also stores the exact response that key produced, as
--    jsonb beside the key it belongs to — no new table, so the existing RLS
--    policy, tenant scoping and backup path cover it unchanged. Rows written
--    before this migration have no stored result; their keys keep the old
--    read-the-row behaviour, which is the best answer still available for them
--    and is explicitly tested.
--
-- 2. **A thousands separator is formatting, not identity.** The canonical
--    serial already drops spaces, dashes, dots, slashes and zero-width marks,
--    because «۱۲۳-۴۵۶» and «۱۲۳۴۵۶» are one cheque. A counter reading the same
--    paper may equally type «۱۲۳٬۴۵۶» (U+066C, the Arabic thousands separator
--    Persian number formatting produces), «۱۲۳٫۴۵۶» (U+066B), «۱۲۳،۴۵۶»
--    (U+060C) or "123,456" — all of which 0217 treated as four more distinct
--    instruments. They are not: a serial number has no arithmetic value, so a
--    group separator inside it can only be presentation. They now fold away
--    too, in SQL and in TypeScript together.
--
--    Widening the fold can make two *existing* rows canonically equal, which
--    the unique index would refuse. That is handled exactly as 0218 handles a
--    legacy collision: the earliest row stays canonical, the later ones are
--    classified into `canonical_duplicate_of` (financial history is kept, not
--    deleted or edited), and the unique index — which only covers unclassified
--    rows — is rebuilt on top. New writes therefore collide with the retained
--    row from the first moment this migration lands.

ALTER TABLE cheques       ADD COLUMN idempotency_result jsonb;
ALTER TABLE cheque_events ADD COLUMN idempotency_result jsonb;

COMMENT ON COLUMN cheques.idempotency_result IS
    'The response the call that created this row returned, replayed verbatim when its idempotency key is used again. NULL for rows written before migration 0219 and for rows written without a key.';
COMMENT ON COLUMN cheque_events.idempotency_result IS
    'The response the call that wrote this event returned, replayed verbatim when its idempotency key is used again. NULL for rows written before migration 0219 and for rows written without a key.';

-- A key without a result is only ever a pre-0219 row: the application writes
-- both or neither, and this says so in the schema rather than in a comment.
ALTER TABLE cheques
    ADD CONSTRAINT cheques_idempotency_result_needs_key
    CHECK (idempotency_result IS NULL OR idempotency_key IS NOT NULL);
ALTER TABLE cheque_events
    ADD CONSTRAINT cheque_events_idempotency_result_needs_key
    CHECK (idempotency_result IS NULL OR idempotency_key IS NOT NULL);

-- --- The widened fold -------------------------------------------------------
-- Schema-qualified and IMMUTABLE for the same reason as 0217: a generated
-- column re-runs this body during `pg_restore`, which runs with an empty
-- `search_path`.
CREATE OR REPLACE FUNCTION public.cheque_canonical_text(raw text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT NULLIF(
        regexp_replace(
            translate(
                lower(btrim(coalesce(raw, ''))),
                '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩يك' || E'\u200b\u200c\u200d\u200e\u200f',
                '01234567890123456789یک'
            ),
            '[[:space:]._/\\,' || E'\u060c\u066b\u066c' || '-]+', '', 'g'
        ),
        ''
    );
$$;

-- Generated columns are computed on write, so an existing row still holds the
-- value the old function produced. Dropping and re-adding the two columns
-- recomputes every row through the new one. The indexes that read them go
-- first and come back below.
DROP INDEX IF EXISTS uq_cheques_canonical_serial;
DROP INDEX IF EXISTS idx_cheques_canonical_serial_all;

ALTER TABLE cheques
    DROP COLUMN bank_name_canonical,
    DROP COLUMN serial_number_canonical;

ALTER TABLE cheques
    ADD COLUMN bank_name_canonical text
        GENERATED ALWAYS AS (public.cheque_canonical_bank(bank_name)) STORED,
    ADD COLUMN serial_number_canonical text
        GENERATED ALWAYS AS (public.cheque_canonical_text(serial_number)) STORED;

-- Collisions the wider fold has just created are classified the 0218 way: the
-- earliest row of each group stays canonical, the rest record which row they
-- duplicate. Rows already classified keep their classification.
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
     WHERE canonical_duplicate_of IS NULL
)
UPDATE cheques c
   SET canonical_duplicate_of = ranked.keeper
  FROM ranked
 WHERE ranked.id = c.id AND ranked.position > 1;

CREATE UNIQUE INDEX uq_cheques_canonical_serial
    ON cheques (business_id, bank_name_canonical, serial_number_canonical)
    WHERE canonical_duplicate_of IS NULL;

CREATE INDEX idx_cheques_canonical_serial_all
    ON cheques (business_id, bank_name_canonical, serial_number_canonical);
