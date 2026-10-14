-- #825: a named statement starts at its party's source records, not at every
-- line on the control account. The existing uq_journal_business_source_posting
-- excludes NULL posting_kind (ordinary receipts/payments), so cannot serve it.
-- Measured with EXPLAIN (ANALYZE, BUFFERS) on 100k entries/200k lines under RLS.
CREATE INDEX idx_journal_entries_business_source
    ON journal_entries (business_id, source_type, source_id)
    WHERE source_id IS NOT NULL;
-- No new tables or data copies: existing table RLS remains authoritative.
