-- ---------------------------------------------------------------------------
-- Cheques: an index for the register's branch filter (issue #828, item 8/12).
-- ---------------------------------------------------------------------------
-- The register is filtered, sorted and counted in SQL. The default ordering is
-- covered by `idx_cheques_due`, and the bank filter by
-- `idx_cheques_canonical_serial_all`, whose leading columns are
-- (business_id, bank_name_canonical). The branch filter had no index: a
-- multi-branch tenant's register would scan the whole cheque book to show one
-- branch. Forward-only and additive; no row is touched.

CREATE INDEX IF NOT EXISTS idx_cheques_location
    ON cheques (business_id, location_id);
