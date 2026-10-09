-- 0216_ar_receipt_idempotency_completion.sql — Issue #829 completion: AR
-- idempotency is a required contract, and the register's account filter reads
-- the actual posting.
--
--   * `ar_receipts.request_fingerprint` — the canonical request tuple, mirroring
--     `ap_payments.request_fingerprint` from 0211 (issue #826). A retry reuses
--     the key with the same fingerprint; a key reused with changed intent is a
--     409 `idempotency_conflict`, never a silent second money movement.
--   * `ar_receipts.idempotency_key` becomes NOT NULL. 0215 left NULL for legacy
--     rows and installment settlements; legacy rows are backfilled with a
--     stable per-row value (they are never retried — the value only needs to
--     be unique), and installments now stamp their own deterministic key, the
--     way the AP side already did. New receipts must carry a client key.
--   * `idx_journal_entries_business_source` — the register joins each voucher
--     to its original journal entry (list query) and the account filter reads
--     the posting's cash line through that join. Until now that join had only
--     the `business_id` prefix of `idx_journal_entries_business_date` to work
--     with; the composite covers (business, source_type, source_id).
--
-- Forward-only; no money or posting is rewritten. The legacy key backfill is
-- the only data touch, and those values are inert (unique, never re-sent).

-- ---------------------------------------------------------------------------
-- 1. Request fingerprint (conflict detection for key reuse)
-- ---------------------------------------------------------------------------
ALTER TABLE ar_receipts ADD COLUMN request_fingerprint text;

-- ---------------------------------------------------------------------------
-- 2. Required idempotency key
-- ---------------------------------------------------------------------------
UPDATE ar_receipts
   SET idempotency_key = 'legacy:' || id::text
 WHERE idempotency_key IS NULL;

ALTER TABLE ar_receipts ALTER COLUMN idempotency_key SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Voucher → original-entry join used by the register and its account filter
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_journal_entries_business_source
    ON journal_entries (business_id, source_type, source_id);
