-- ============================================================================
-- 0232_warehouse_document_register_hardening.sql — Issue #923 (warehouse register)
--
-- Hardens the «رسید و حواله‌های انبار» register so posted vouchers stay
-- findable, branch-authorized, historically accurate and financially
-- traceable even when mutable master data (items, batches, users, branches)
-- changes:
--
--   * voucher_number — an auto-assigned, immutable, human-readable internal
--     number per business (year-sequenced, unique under concurrency via the
--     partial unique index below). Distinct from the optional external
--     document_number (supplier invoice no. / حواله کاغذی). Creation-side
--     assignment is coordinated with #922; this migration backfills existing
--     posted documents so the register can display and search by it.
--   * business_date — the document's business (Jalali-display) date,
--     distinct from created_at (the posting timestamp). Defaults to the
--     posting day; creation-side may override (#922).
--   * created_by_name — snapshot of the actor's name at posting time, so the
--     voucher stays legible after the actor's account is deactivated or
--     deleted (created_by is ON DELETE SET NULL).
--   * Line snapshots (item_name, item_unit / item_tracking) — the original
--     identifying/display attributes of each line, read by the detail view
--     instead of a live join that would show a renamed/deleted item's current
--     name. Null means "legacy document, not snapshotted"; the UI marks such
--     values as current/legacy rather than pretending they were snapshotted.
--   * warehouse_document_lines.inventory_item_id: ON DELETE CASCADE → ON
--     DELETE RESTRICT, so a hard item deletion can no longer erase posted
--     voucher lines. Deliberate whole-business teardown still cascades through
--     businesses → locations → documents → lines.
--   * Register indexes serving tenant + permitted branch + kind + date with
--     the (created_at, id) keyset tie-breaker used by the paginated list.
--
-- Tenancy + RLS: no new tables; the new columns inherit the tables' existing
-- FORCE ROW LEVEL SECURITY policies. No RLS change needed.
-- ============================================================================

-- 1) Internal voucher number + business date + actor snapshot on both headers.
ALTER TABLE warehouse_documents
    ADD COLUMN voucher_number text,
    ADD COLUMN business_date date,
    ADD COLUMN created_by_name text;

ALTER TABLE retail_warehouse_documents
    ADD COLUMN voucher_number text,
    ADD COLUMN business_date date,
    ADD COLUMN created_by_name text;

-- One internal number per business. Format `W-<Gregorian year>-<seq>`;
-- year sequencing is documented here and enforced by creation-side code
-- (#922) that reserves the next sequence inside the posting transaction.
CREATE UNIQUE INDEX uq_warehouse_documents_voucher_number
    ON warehouse_documents (business_id, voucher_number)
    WHERE voucher_number IS NOT NULL;

CREATE UNIQUE INDEX uq_retail_warehouse_documents_voucher_number
    ON retail_warehouse_documents (business_id, voucher_number)
    WHERE voucher_number IS NOT NULL;

-- 2) Register indexes: tenant, permitted branch, kind, posting date, then
--    the keyset tie-breaker (id) used by `ORDER BY created_at DESC, id`.
CREATE INDEX idx_warehouse_documents_register
    ON warehouse_documents (business_id, location_id, kind, created_at DESC, id);

CREATE INDEX idx_retail_warehouse_documents_register
    ON retail_warehouse_documents (business_id, location_id, kind, created_at DESC, id);

-- 3) Line snapshots: original identifying/display attributes at posting time.
ALTER TABLE warehouse_document_lines
    ADD COLUMN item_name text,
    ADD COLUMN item_unit text;

ALTER TABLE retail_warehouse_document_lines
    ADD COLUMN item_name text,
    ADD COLUMN item_tracking text;

-- 4) History-safe retention: a posted voucher's lines must not vanish on
--    hard item deletion. RESTRICT keeps header + line count + value intact;
--    only a whole-business teardown (locations cascade) removes them.
ALTER TABLE warehouse_document_lines
    DROP CONSTRAINT warehouse_document_lines_inventory_item_id_fkey;

ALTER TABLE warehouse_document_lines
    ADD CONSTRAINT warehouse_document_lines_inventory_item_id_fkey
        FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE RESTRICT;

-- 5) Backfill existing posted documents so legacy vouchers are complete.
--    Voucher numbers: per business, per Gregorian posting year, in posted
--    order — stable, never reused, never reassigned.
WITH numbered AS (
    SELECT
        id,
        to_char(created_at, 'YYYY') AS year,
        row_number() OVER (
            PARTITION BY business_id, to_char(created_at, 'YYYY')
            ORDER BY created_at, id
        ) AS seq
    FROM warehouse_documents
    WHERE voucher_number IS NULL
)
UPDATE warehouse_documents d
SET voucher_number = 'W-' || n.year || '-' || lpad(n.seq::text, 4, '0'),
    business_date = d.created_at::date,
    created_by_name = u.full_name
FROM numbered n
LEFT JOIN users u ON u.id = d.created_by
WHERE d.id = n.id;

WITH numbered AS (
    SELECT
        id,
        to_char(created_at, 'YYYY') AS year,
        row_number() OVER (
            PARTITION BY business_id, to_char(created_at, 'YYYY')
            ORDER BY created_at, id
        ) AS seq
    FROM retail_warehouse_documents
    WHERE voucher_number IS NULL
)
UPDATE retail_warehouse_documents d
SET voucher_number = 'W-' || n.year || '-' || lpad(n.seq::text, 4, '0'),
    business_date = d.created_at::date,
    created_by_name = u.full_name
FROM numbered n
LEFT JOIN users u ON u.id = d.created_by
WHERE d.id = n.id;

-- 6) Backfill line snapshots where the referenced item still exists.
--    Items already deleted before this migration took their lines with the
--    old CASCADE rule — that history is gone, and nothing here invents it.
--    Rows whose item is gone stay null and render as legacy/current values.
UPDATE warehouse_document_lines l
SET item_name = ii.name,
    item_unit = ii.unit
FROM inventory_items ii
WHERE ii.id = l.inventory_item_id;

UPDATE retail_warehouse_document_lines l
SET item_name = i.name,
    item_tracking = i.tracking
FROM items i
WHERE i.id = l.item_id;
