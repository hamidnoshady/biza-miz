-- Issue #902 §9 item 3 — say which price actually produced a rated amount.
--
-- `billing_usage_ratings` has one provenance column, `price_version_id`, and it
-- references `billing_price_versions` — the *meter* catalogue. Every messaging
-- charge, however, is priced by `kavenegar_retail_price_versions` (§4): markup,
-- slabs, overrides, an occasional promotion. Two consequences, both wrong, both
-- invisible because the column is always filled:
--
--   * the rating cited a meter version whose numbers were never used, so
--     "which price version produced this invoice line?" had a confident and
--     false answer;
--   * the retail version that *did* price the send lived only in
--     `billing_vendor_cost_events.metadata` and the wallet entry's metadata,
--     i.e. in free-form JSON that nothing can join against.
--
-- §9 item 3 asks for usage ratings and invoice lines emitted "from the same
-- versions" as the charge. This migration makes the version a first-class
-- column, so the statement becomes checkable rather than asserted.
--
-- `price_basis` is what keeps the table honest about all three cases:
--
--   * `meter_price_version`   — priced by a published `billing_price_versions` row;
--   * `retail_price_version`  — priced by a `kavenegar_retail_price_versions` row,
--                               so `price_version_id` must be NULL (it is a
--                               different catalogue, and citing it would be a lie);
--   * `explicit_amount`       — the caller computed the amount from a feature
--                               price or a config rate. Nothing to cite, which is
--                               now said out loud instead of pointing at whatever
--                               meter price happened to be current.
--
-- NULL for rows written before this migration: unknown, not guessed. Same rule
-- as `message_outbox.send_latency_ms` (0268) — a backfilled guess would be
-- indistinguishable from evidence.

ALTER TABLE billing_usage_ratings
    ADD COLUMN price_basis text
        CHECK (price_basis IN ('meter_price_version', 'retail_price_version', 'explicit_amount')),
    -- The retail catalogue, by id when the row still exists…
    ADD COLUMN retail_price_version_id uuid
        REFERENCES kavenegar_retail_price_versions(id) ON DELETE SET NULL,
    -- …and by number always: the built-in default is version 0 with no row at
    -- all, and the number is the part an operator recognises.
    ADD COLUMN retail_price_version integer
        CHECK (retail_price_version IS NULL OR retail_price_version >= 0);

COMMENT ON COLUMN billing_usage_ratings.price_basis IS
    'Issue #902 §9 item 3: meter_price_version | retail_price_version | explicit_amount. NULL = written before 0270, unknown rather than guessed.';
COMMENT ON COLUMN billing_usage_ratings.retail_price_version IS
    'The kavenegar_retail_price_versions number that priced this charge. 0 = the built-in default, which has no row.';
COMMENT ON COLUMN billing_usage_ratings.retail_price_version_id IS
    'The retail price version row, when one exists. NULL for the built-in default (version 0).';

-- The three columns must agree with each other. Each CHECK is written so that a
-- legacy row (all NULL) passes: a NULL comparison is NULL, and a CHECK only
-- rejects an explicit FALSE.
ALTER TABLE billing_usage_ratings
    -- A retail-priced row knows its retail version number, and a row with no
    -- retail basis cannot claim one. This is the pair that makes the citation
    -- meaningful: half of it is never enough.
    ADD CONSTRAINT billing_usage_ratings_retail_basis_paired
        CHECK ((price_basis = 'retail_price_version') = (retail_price_version IS NOT NULL)),
    -- An id without a number cannot be rendered or understood.
    ADD CONSTRAINT billing_usage_ratings_retail_id_needs_number
        CHECK (retail_price_version_id IS NULL OR retail_price_version IS NOT NULL),
    -- A retail-priced row must not point at the meter catalogue: that column
    -- references a different table and would be a false citation.
    ADD CONSTRAINT billing_usage_ratings_retail_has_no_meter_version
        CHECK (price_basis IS DISTINCT FROM 'retail_price_version' OR price_version_id IS NULL);

-- "Which charges did version N price?" is the question this migration exists to
-- answer, and it is asked per period.
CREATE INDEX idx_billing_usage_ratings_retail_version
    ON billing_usage_ratings (retail_price_version, created_at DESC)
    WHERE retail_price_version IS NOT NULL;
