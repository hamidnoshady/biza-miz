-- 0212_ar_ap_receipts_hardening.sql — Issue #829: idempotency, reversal, settlement accounts, pagination.
--
-- `ar_receipts` / `ap_payments` are the combined دریافت و پرداخت voucher workspace.
-- This migration adds the columns the hardening needs, without rewriting history:
--
--   * `idempotency_key` — client-generated per logical voucher submission.
--     Unique per business where present (retries with the same key return the
--     original row instead of posting twice). NULL stays allowed for legacy
--     rows and installment settlements, which are idempotent by their own key.
--   * `settlement_account_id` — the explicit cash/bank asset account the voucher
--     posts against. `method` stays as classification/display metadata. Legacy
--     rows are backfilled to their historical posting account (cash -> 1100,
--     bank -> 1120, the pre-#829 mapping), so the register keeps showing the
--     account the money actually moved on even after `bank` means direct bank
--     (1110) for new vouchers.
--   * `method` gains 'clearing' (POS/card/PSP money in transit, 1120). New
--     `bank` vouchers post to the real bank account (1110).
--   * `reversed_at` / `reversed_by` / `reversal_entry_id` — source-level
--     reversal state. The reversal journal mirrors the original entry exactly
--     (same source_type/source_id, posting_kind *_reversal) so A/R and A/P
--     party attribution is preserved.
--   * `voucher_number` — stable per-business sequential document number. The
--     list's old `#` column was `index + 1` and changed with every query; this
--     number never changes. Assigned from `ar_ap_voucher_counters` under a row
--     lock in the service layer (see ar-service.ts / ap-service.ts).
--   * List indexes aligned with the register's newest-first order
--     (business + voucher date + created_at + id).
--
-- Forward-only; no legacy row is rewritten except for the two backfills above,
-- which record what was already true about that row.

-- ---------------------------------------------------------------------------
-- 1. New columns
-- ---------------------------------------------------------------------------
ALTER TABLE ar_receipts
    ADD COLUMN idempotency_key text
        CHECK (idempotency_key IS NULL OR (char_length(idempotency_key) BETWEEN 1 AND 128)),
    ADD COLUMN settlement_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
    ADD COLUMN reversed_at timestamptz,
    ADD COLUMN reversed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN reversal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    ADD COLUMN voucher_number bigint CHECK (voucher_number IS NULL OR voucher_number > 0);

ALTER TABLE ap_payments
    ADD COLUMN idempotency_key text
        CHECK (idempotency_key IS NULL OR (char_length(idempotency_key) BETWEEN 1 AND 128)),
    ADD COLUMN settlement_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
    ADD COLUMN reversed_at timestamptz,
    ADD COLUMN reversed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN reversal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    ADD COLUMN voucher_number bigint CHECK (voucher_number IS NULL OR voucher_number > 0);

-- No CHECK links reversed_at to reversal_entry_id, deliberately: the FK is
-- ON DELETE SET NULL (matching journal_entries.reverses_entry_id from 0029),
-- and a link check would contradict it — deleting the entry nulls one column
-- while the timestamp stands, failing the check. The service is the only
-- writer and always sets/clears the three reversal columns atomically; the
-- journal itself (0029) and payroll voids (0150) keep the same discipline
-- without a link check.

-- ---------------------------------------------------------------------------
-- 2. `method` gains the clearing settlement (1120 stays reachable explicitly)
-- ---------------------------------------------------------------------------
ALTER TABLE ar_receipts DROP CONSTRAINT IF EXISTS ar_receipts_method_check;
ALTER TABLE ar_receipts
    ADD CONSTRAINT ar_receipts_method_check CHECK (method IN ('cash', 'bank', 'clearing'));

ALTER TABLE ap_payments DROP CONSTRAINT IF EXISTS ap_payments_method_check;
ALTER TABLE ap_payments
    ADD CONSTRAINT ap_payments_method_check CHECK (method IN ('cash', 'bank', 'clearing'));

-- ---------------------------------------------------------------------------
-- 3. Settlement-account affinity: the account must be this business's own
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ar_receipt_settlement_affinity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.settlement_account_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM accounts a
         WHERE a.id = NEW.settlement_account_id AND a.business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'invalid_settlement_account' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ar_receipt_settlement_affinity ON ar_receipts;
CREATE TRIGGER trg_ar_receipt_settlement_affinity
    BEFORE INSERT OR UPDATE OF settlement_account_id, business_id ON ar_receipts
    FOR EACH ROW EXECUTE FUNCTION ar_receipt_settlement_affinity();

CREATE OR REPLACE FUNCTION ap_payment_settlement_affinity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.settlement_account_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM accounts a
         WHERE a.id = NEW.settlement_account_id AND a.business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'invalid_settlement_account' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ap_payment_settlement_affinity ON ap_payments;
CREATE TRIGGER trg_ap_payment_settlement_affinity
    BEFORE INSERT OR UPDATE OF settlement_account_id, business_id ON ap_payments
    FOR EACH ROW EXECUTE FUNCTION ap_payment_settlement_affinity();

-- ---------------------------------------------------------------------------
-- 4. Backfill legacy settlement accounts (historical posting truth)
-- ---------------------------------------------------------------------------
-- cash -> 1100, bank -> 1120 (the pre-#829 mapping). A business whose chart no
-- longer carries the account keeps NULL rather than pointing at a wrong one.
UPDATE ar_receipts r
   SET settlement_account_id = a.id
  FROM accounts a
 WHERE r.settlement_account_id IS NULL
   AND a.business_id = r.business_id
   AND a.code = CASE WHEN r.method = 'cash' THEN '1100' ELSE '1120' END;

UPDATE ap_payments p
   SET settlement_account_id = a.id
  FROM accounts a
 WHERE p.settlement_account_id IS NULL
   AND a.business_id = p.business_id
   AND a.code = CASE WHEN p.method = 'cash' THEN '1100' ELSE '1120' END;

-- ---------------------------------------------------------------------------
-- 5. Per-business sequential voucher numbers + counters
-- ---------------------------------------------------------------------------
CREATE TABLE ar_ap_voucher_counters (
    business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    last_ar_voucher_number bigint NOT NULL DEFAULT 0 CHECK (last_ar_voucher_number >= 0),
    last_ap_voucher_number bigint NOT NULL DEFAULT 0 CHECK (last_ap_voucher_number >= 0)
);

ALTER TABLE ar_ap_voucher_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_ap_voucher_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ar_ap_voucher_counters FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Number existing vouchers oldest-first per business so the sequence reads in
-- posting order. Ordered by the same keys the register sorts on.
WITH numbered AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY business_id
               ORDER BY receipt_date, created_at, id
           ) AS seq
      FROM ar_receipts
     WHERE voucher_number IS NULL
)
UPDATE ar_receipts r
   SET voucher_number = numbered.seq
  FROM numbered
 WHERE r.id = numbered.id;

WITH numbered AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY business_id
               ORDER BY payment_date, created_at, id
           ) AS seq
      FROM ap_payments
     WHERE voucher_number IS NULL
)
UPDATE ap_payments p
   SET voucher_number = numbered.seq
  FROM numbered
 WHERE p.id = numbered.id;

-- Counters resume after the highest number each business already holds.
INSERT INTO ar_ap_voucher_counters (business_id, last_ar_voucher_number, last_ap_voucher_number)
SELECT b.id,
       COALESCE((SELECT max(voucher_number) FROM ar_receipts r WHERE r.business_id = b.id), 0),
       COALESCE((SELECT max(voucher_number) FROM ap_payments p WHERE p.business_id = b.id), 0)
  FROM businesses b
ON CONFLICT (business_id) DO NOTHING;

CREATE UNIQUE INDEX uq_ar_receipts_business_voucher_number
    ON ar_receipts (business_id, voucher_number)
    WHERE voucher_number IS NOT NULL;
CREATE UNIQUE INDEX uq_ap_payments_business_voucher_number
    ON ap_payments (business_id, voucher_number)
    WHERE voucher_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. Idempotency uniqueness (NULLs ignored: legacy/installment rows carry none)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX uq_ar_receipts_business_idempotency
    ON ar_receipts (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_ap_payments_business_idempotency
    ON ap_payments (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. Register list indexes (business + voucher date + created_at + id)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ar_receipts_business_date_list
    ON ar_receipts (business_id, receipt_date DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ap_payments_business_date_list
    ON ap_payments (business_id, payment_date DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ar_receipts_settlement_account
    ON ar_receipts (settlement_account_id) WHERE settlement_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ap_payments_settlement_account
    ON ap_payments (settlement_account_id) WHERE settlement_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ar_receipts_location_date
    ON ar_receipts (business_id, location_id, receipt_date DESC) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ap_payments_location_date
    ON ap_payments (business_id, location_id, payment_date DESC) WHERE location_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 8. Installment slice settlements share the voucher settlement vocabulary
-- ---------------------------------------------------------------------------
ALTER TABLE installment_items DROP CONSTRAINT IF EXISTS installment_items_paid_method_check;
ALTER TABLE installment_items
    ADD CONSTRAINT installment_items_paid_method_check CHECK (paid_method IN ('cash', 'bank', 'clearing'));
