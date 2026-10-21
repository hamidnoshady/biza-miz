-- ============================================================================
-- 0236_warehouse_document_hardening.sql — Issue #922 (Biza-Miz Accounting Inventory)
--
-- P0 branch security is enforced in the application layer (authorize with
-- live membership scope). This migration adds the persistence needed for
-- the remaining P1/P2 guarantees:
--
--  1. Idempotency: a stable per-draft key lets a retry after a lost response
--     return the original voucher instead of posting stock and GL twice.
--     Unique on (business_id, idempotency_key) where not null, mirroring
--     inventory_events' own key. Payload hash is stored alongside so a replay
--     with a changed payload is a 409 rather than a silent no-op.
--     Indexes: uq_warehouse_documents_business_idempotency,
--              uq_retail_warehouse_documents_business_idempotency
--
--  2. Internal voucher number: separate from external document_number, auto-
--     generated per branch+kind sequence, unique where present.
--     Indexes: uq_warehouse_documents_voucher,
--              uq_retail_warehouse_documents_voucher
--
--  3. Document number uniqueness: uq_warehouse_documents_number (business_id, document_number)
--     where document_number IS NOT NULL — guarded against existing duplicates.
--
--  4. Exact costing reconciliation (retail): preserve authoritative carrying
--     value at the batch and stock level instead of deriving it from a
--     rounded average. New columns hold the exact Rial total per batch and
--     per stock row; existing rows are backfilled from quantity*unit_cost.
--     Columns: item_batches.total_value_rial, item_stock.total_value_rial
--
--  5. Reversal trace: every document can reference the document it corrects,
--     so an unrelated opposite receipt is not the correction history.
--     Indexes: uq_warehouse_documents_reversed_of,
--              uq_retail_warehouse_documents_reversed_of (partial unique on reversed_of)
--
--  6. Branch-scoped voucher sequence: warehouse_voucher_sequences
--
--  7. Free-goods policy: documents may carry an explicit reason when they
--     move stock at zero value; otherwise zero-value receipts remain refused
--     at the service layer (receipt_value_required). This column documents
--     the approval/audit trail when the business does support free goods.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Idempotency & internal voucher on both document tables
-- ---------------------------------------------------------------------------

ALTER TABLE warehouse_documents
    ADD COLUMN IF NOT EXISTS idempotency_key text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 128),
    ADD COLUMN IF NOT EXISTS payload_hash text,
    ADD COLUMN IF NOT EXISTS internal_voucher_number text,
    ADD COLUMN IF NOT EXISTS reversed_of uuid REFERENCES warehouse_documents(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reversal_reason text,
    ADD COLUMN IF NOT EXISTS is_reversal boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS free_goods_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_documents_business_idempotency
    ON warehouse_documents (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_documents_voucher
    ON warehouse_documents (business_id, location_id, kind, internal_voucher_number) WHERE internal_voucher_number IS NOT NULL;

ALTER TABLE retail_warehouse_documents
    ADD COLUMN IF NOT EXISTS idempotency_key text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 128),
    ADD COLUMN IF NOT EXISTS payload_hash text,
    ADD COLUMN IF NOT EXISTS internal_voucher_number text,
    ADD COLUMN IF NOT EXISTS reversed_of uuid REFERENCES retail_warehouse_documents(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reversal_reason text,
    ADD COLUMN IF NOT EXISTS is_reversal boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS free_goods_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_retail_warehouse_documents_business_idempotency
    ON retail_warehouse_documents (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_retail_warehouse_documents_voucher
    ON retail_warehouse_documents (business_id, location_id, kind, internal_voucher_number) WHERE internal_voucher_number IS NOT NULL;

-- Guard the new unique document_number index against existing duplicates:
-- If duplicate (business_id, document_number) exists, keep earliest and null duplicates before creating unique index
UPDATE warehouse_documents
SET document_number = NULL
WHERE document_number IS NOT NULL
  AND ctid NOT IN (
    SELECT min_ctid FROM (
      SELECT min(ctid) AS min_ctid
      FROM warehouse_documents
      WHERE document_number IS NOT NULL
      GROUP BY business_id, document_number
    ) s
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_documents_number
    ON warehouse_documents (business_id, document_number) WHERE document_number IS NOT NULL;

-- Reversal uniqueness: one reversal per original document (partial unique)
CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_documents_reversed_of
    ON warehouse_documents (business_id, reversed_of) WHERE reversed_of IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_retail_warehouse_documents_reversed_of
    ON retail_warehouse_documents (business_id, reversed_of) WHERE reversed_of IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Exact carrying value for retail batches (P1 costing reconciliation)
-- ---------------------------------------------------------------------------
-- The current model derives inventory value as SUM(quantity * unit_cost) with
-- whole-Rial unit_costs, while the GL posting is the exact extended value
-- (qty × unitCost). With non-integer averages (e.g. 1@100 + 1@101 → avg 100.5
-- → rounded 101 → 202 vs GL 201) the two drift. These columns preserve the
-- authoritative exact total per lot and per stock row; the rounded unit_cost
-- remains for display but is no longer the accounting source of truth.

ALTER TABLE item_batches
    ADD COLUMN IF NOT EXISTS total_value_rial bigint CHECK (total_value_rial IS NULL OR total_value_rial >= 0);

ALTER TABLE item_stock
    ADD COLUMN IF NOT EXISTS total_value_rial bigint CHECK (total_value_rial IS NULL OR total_value_rial >= 0);

-- Backfill existing batches: exact value = round(quantity * unit_cost) where
-- cost is known; null-cost batches keep null (unknown cost basis).
UPDATE item_batches
   SET total_value_rial = CASE
       WHEN unit_cost IS NOT NULL THEN round(quantity * unit_cost)::bigint
       ELSE NULL
   END
 WHERE total_value_rial IS NULL;

-- Backfill item_stock: sum of its batches' exact totals where batch-tracked,
-- otherwise quantity * unit_cost.
UPDATE item_stock s
   SET total_value_rial = COALESCE(
       (SELECT sum(b.total_value_rial)::bigint FROM item_batches b WHERE b.item_id = s.item_id),
       CASE WHEN s.unit_cost IS NOT NULL THEN round(s.quantity * s.unit_cost)::bigint ELSE 0 END
   )
 WHERE s.total_value_rial IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Branch-scoped voucher sequence (for auto-generated internal numbers)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouse_voucher_sequences (
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('receipt', 'issue', 'disposal', 'internal_use')),
    last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0),
    PRIMARY KEY (business_id, location_id, kind)
);

-- Add/replace kind check without swallowing errors via WHEN OTHERS
ALTER TABLE warehouse_voucher_sequences DROP CONSTRAINT IF EXISTS warehouse_voucher_sequences_kind_check;
ALTER TABLE warehouse_voucher_sequences ADD CONSTRAINT warehouse_voucher_sequences_kind_check CHECK (kind IN ('receipt', 'issue', 'disposal', 'internal_use'));

-- Retail documents now support disposal/internal_use kinds for expired-lot disposition
ALTER TABLE retail_warehouse_documents DROP CONSTRAINT IF EXISTS retail_warehouse_documents_kind_check;
ALTER TABLE retail_warehouse_documents ADD CONSTRAINT retail_warehouse_documents_kind_check CHECK (kind IN ('receipt', 'issue', 'disposal', 'internal_use'));

-- RLS: same business_id isolation as every tenant table (fixes data-transfer/tenant-isolation sweep)
ALTER TABLE warehouse_voucher_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_voucher_sequences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON warehouse_voucher_sequences;
CREATE POLICY tenant_isolation ON warehouse_voucher_sequences FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE warehouse_voucher_sequences IS 'Per-branch monotonic voucher counter for internal warehouse document numbers (issue #922).';
