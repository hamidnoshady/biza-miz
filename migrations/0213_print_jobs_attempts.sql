-- Print history records print ATTEMPTS, one row each.
--
-- 0173 made `print_request_id` NOT NULL and UNIQUE (location_id, print_request_id),
-- and the application only wrote a row when the caller supplied that id. Two
-- consequences, both of them bad for the operator reading «فعالیت اخیر»:
--
--   * a print that carried no request id left no trace at all — the endpoint
--     rendered and delivered it, and history never heard about it;
--   * the ids the screens pass are per DOCUMENT (`receipt:{orderId}`,
--     `label:{code}`, `kitchen:{orderId}`), so the second print of the same
--     receipt collided with the first row. `ON CONFLICT DO NOTHING` then made
--     the collision silent: "how many times was this bill printed?" had no
--     answer, and a failed first attempt could not be followed by a recorded
--     successful retry.
--
-- From here on the row's own `id` is the attempt — the server mints one per
-- request and answers with it, and the delivery acknowledgement
-- (PATCH /api/printing/jobs) addresses that exact row. `print_request_id`
-- becomes what it always read like: the caller's correlation id, free to
-- repeat, kept for support ("which screen asked for this?").
ALTER TABLE print_jobs
    ALTER COLUMN print_request_id DROP NOT NULL;

-- Drop the unique constraint under whatever name Postgres gave it — a named
-- constraint on a fresh install, possibly a bare unique index on an older one.
DO $$
DECLARE found record;
BEGIN
    FOR found IN
        SELECT conname AS name
          FROM pg_constraint
         WHERE conrelid = 'print_jobs'::regclass
           AND contype = 'u'
           AND pg_get_constraintdef(oid) LIKE '%(location_id, print_request_id)%'
    LOOP
        EXECUTE format('ALTER TABLE print_jobs DROP CONSTRAINT %I', found.name);
    END LOOP;

    FOR found IN
        SELECT indexname AS name
          FROM pg_indexes
         WHERE tablename = 'print_jobs'
           AND indexdef LIKE 'CREATE UNIQUE INDEX%'
           AND indexdef LIKE '%(location_id, print_request_id)%'
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', found.name);
    END LOOP;
END $$;

-- The correlation id stays queryable (support reads it; the legacy
-- acknowledgement path matches on it) but is no longer an identity.
CREATE INDEX IF NOT EXISTS idx_print_jobs_request
    ON print_jobs (location_id, print_request_id);
