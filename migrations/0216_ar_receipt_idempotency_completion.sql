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
--   * The register's voucher → original-entry join (list query + account
--     filter) is covered by `idx_journal_entries_business_source`, owned by
--     0216_subledger_statement_access.sql: every consumer filters
--     `source_id` by non-null equality, so that file's partial composite
--     serves them all and this file creates no second index under the name.
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
