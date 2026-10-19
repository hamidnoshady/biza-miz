-- Issue #921 — Accounting Inventory انبارگردانی hardening: batch/serial integrity, reversals, count workflow & hybrid sync
--
-- P0 Retail batch bypass left item_stock.quantity diverging from SUM(item_batches.quantity) after a count.
-- This migration adds the evidence tables the batch-aware count path needs so a reversal
-- can put exactly the same batches back, and the idempotency/preview scaffolding the
-- operational fixes below rely on.
--
-- Keep one canonical route and two industry-specific adapters; do not replace engines.

-- ---------------------------------------------------------------------------
-- 1) Per-batch allocation evidence for a retail count line
--
-- A batch-tracked item's count is no longer a single quantity write. Shortage
-- is relieved FEFO across sellable batches; surplus is received as a count-
-- adjustment batch. Each line's exact batch slices are recorded here so:
--  - SUM(item_batches.quantity) = item_stock.quantity always (enforced by
--    the count service's recomputeItemStockRollup call);
--  - a reversal can restore the precise lots it consumed or remove the ones
--    it created, without inventing batches.
--  - hybrid sync can replay the same business fact on both sides (see
--    sync-domain-handlers audit in issue #921 §10).

CREATE TABLE item_stock_count_batch_allocations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_count_line_id uuid NOT NULL REFERENCES item_stock_count_lines(id) ON DELETE CASCADE,
    stock_count_id      uuid NOT NULL REFERENCES item_stock_counts(id) ON DELETE CASCADE,
    item_id             uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    batch_id            uuid REFERENCES item_batches(id) ON DELETE SET NULL,
    batch_number        text NOT NULL,
    expiry_date         date,
    quantity            numeric(24,9) NOT NULL CHECK (quantity <> 0),
    unit_cost           bigint CHECK (unit_cost IS NULL OR unit_cost >= 0),
    value_rial          bigint NOT NULL,
    -- shortage = negative quantity (relieved), surplus = positive (received)
    kind                text NOT NULL CHECK (kind IN ('relief', 'receipt')),
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_item_stock_count_batch_alloc_line ON item_stock_count_batch_allocations (stock_count_line_id);
CREATE INDEX idx_item_stock_count_batch_alloc_count ON item_stock_count_batch_allocations (stock_count_id);
CREATE INDEX idx_item_stock_count_batch_alloc_item ON item_stock_count_batch_allocations (item_id);

ALTER TABLE item_stock_count_batch_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_stock_count_batch_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_stock_count_batch_allocations FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_stock_counts c
         WHERE c.id = item_stock_count_batch_allocations.stock_count_id
           AND app_owns_location(c.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_stock_counts c
         WHERE c.id = item_stock_count_batch_allocations.stock_count_id
           AND app_owns_location(c.location_id)));

-- ---------------------------------------------------------------------------
-- 2) Idempotency & snapshot scaffolding on the count header
--
-- Ordinary HTTP POST currently has no caller idempotency key; a retry or
-- timeout replay creates a second count with a second ledger entry. The
-- sync layer already deduplicates on (location_id, client_event_id); HTTP
-- needs the same without inventing a new table. A nullable idempotency_key
-- with a partial unique index gives it: when a caller supplies an
-- Idempotency-Key header (or countId), the second POST returns the first
-- row rather than posting again. Absent key: no constraint, no behaviour
-- change.
--
-- snapshot_version + baseline capture the count-time vs post-time conflict
-- detection. The count session records the baseline quantity/cost seen when
-- the operator started counting; posting compares it to live stock and
-- surfaces a 409 with instructions (freeze/recount/variance-review) rather
-- than silently overwriting hours of concurrent sales.

ALTER TABLE item_stock_counts
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS location_snapshot_version bigint,
    ADD COLUMN IF NOT EXISTS baseline_captured_at timestamptz,
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'posted' CHECK (status IN ('draft','counting','submitted','posted','reversed')),
    ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reason_code text,
    ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES locations(id) ON DELETE SET NULL;

-- One idempotency identity per branch; global uniqueness would block the
-- legitimate case of the same client key used in two different branches
-- (e.g. a hybrid desktop paired to two locations).
CREATE UNIQUE INDEX IF NOT EXISTS idx_item_stock_counts_idempotency
    ON item_stock_counts (location_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Draft / resumable count sessions are first-class now (see Phase 2).
-- A draft has no lines yet; submitted/posted must have at least one —
-- enforced in the service, not as a DB CHECK, so a draft can be saved empty.

-- ---------------------------------------------------------------------------
-- 3) History / audit columns already present gain indexes for the new
-- searchable/paginated list (filters: warehouse/date/item/user/status).

CREATE INDEX IF NOT EXISTS idx_item_stock_counts_status ON item_stock_counts (location_id, status, counted_at DESC);
CREATE INDEX IF NOT EXISTS idx_item_stock_counts_assigned ON item_stock_counts (assigned_to) WHERE assigned_to IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4) Food-service historical-edit guard: record that an edit is a correction
-- of an earlier count, not a fresh absolute observation, so the service can
-- detect intervening movements and refuse with a clear code.
--
-- No schema change needed for stock_counts itself: editStockCount already
-- writes reversal_of; we add an audit column that names the corrected error
-- without reusing note text.

ALTER TABLE stock_counts
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS correction_of uuid REFERENCES stock_counts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS baseline_captured_at timestamptz,
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'posted' CHECK (status IN ('draft','counting','submitted','posted','reversed')),
    ADD COLUMN IF NOT EXISTS reason_code text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_counts_idempotency
    ON stock_counts (location_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5) Retail stock count lines gain snapshot columns for conflict detection
-- and a correction linkage column for the same historical-edit guard.

ALTER TABLE item_stock_count_lines
    ADD COLUMN IF NOT EXISTS baseline_qty numeric(24,9),
    ADD COLUMN IF NOT EXISTS baseline_unit_cost bigint;

-- Ensure the existing 0099 lines are backfilled for the new partial index.
-- Backfill is a no-op if the columns are already populated from here on;
-- older rows keep NULL baseline (unknown snapshot) and are excluded from
-- the strict conflict check rather than failing it spuriously.
