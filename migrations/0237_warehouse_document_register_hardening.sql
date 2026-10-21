-- ============================================================================
-- 0237_warehouse_document_register_hardening.sql — Issue #923 (warehouse register)
--
-- Hardens the «رسید و حواله‌های انبار» register so posted vouchers stay
-- findable, branch-authorized, historically accurate and financially
-- traceable even when mutable master data (items, batches, users, branches)
-- changes:
--
--   * Internal voucher identity: #922 already added internal_voucher_number
--     (branch+kind sequence, unique per business/location/kind) and that is
--     the register's permanent identifier — this migration does NOT add a
--     second numbering scheme. It only backfills legacy documents that predate
--     #922 so the register can display and search an identity for them, and
--     seeds warehouse_voucher_sequences past the backfilled numbers so the
--     next live document cannot collide with a backfilled one.
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

-- 1) Business date + actor snapshot on both headers. (The internal voucher
--    number itself is #922's `internal_voucher_number`; nothing is duplicated
--    here.)
ALTER TABLE warehouse_documents
    ADD COLUMN business_date date,
    ADD COLUMN created_by_name text;

ALTER TABLE retail_warehouse_documents
    ADD COLUMN business_date date,
    ADD COLUMN created_by_name text;

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
--    Identity (#922's internal_voucher_number): docs posted before #922 carry
--    none. Number them per branch+kind in posted order with the same format
--    the service uses (RCV-/ISS-<year>-<5 digits>), then move each branch+kind
--    sequence past the highest backfilled number so the next live document
--    cannot reuse a backfilled one. Documents that already have a number are
--    left untouched — a number is never reassigned.
WITH numbered AS (
    SELECT
        d.id,
        d.business_id,
        d.location_id,
        d.kind,
        'RCV-' || to_char(d.created_at, 'YYYY') || '-' ||
            lpad(row_number() OVER (
                PARTITION BY d.business_id, d.location_id, d.kind, to_char(d.created_at, 'YYYY')
                ORDER BY d.created_at, d.id
            )::text, 5, '0') AS new_number,
        d.created_at::date AS new_business_date,
        (SELECT u.full_name FROM users u WHERE u.id = d.created_by) AS actor_name
    FROM warehouse_documents d
    WHERE d.internal_voucher_number IS NULL
)
UPDATE warehouse_documents d
SET internal_voucher_number = n.new_number,
    business_date = n.new_business_date,
    created_by_name = n.actor_name
FROM numbered n
WHERE d.id = n.id;

WITH numbered AS (
    SELECT
        d.id,
        'RCV-' || to_char(d.created_at, 'YYYY') || '-' ||
            lpad(row_number() OVER (
                PARTITION BY d.business_id, d.location_id, d.kind, to_char(d.created_at, 'YYYY')
                ORDER BY d.created_at, d.id
            )::text, 5, '0') AS new_number,
        d.created_at::date AS new_business_date,
        (SELECT u.full_name FROM users u WHERE u.id = d.created_by) AS actor_name
    FROM retail_warehouse_documents d
    WHERE d.internal_voucher_number IS NULL
)
UPDATE retail_warehouse_documents d
SET internal_voucher_number = n.new_number,
    business_date = n.new_business_date,
    created_by_name = n.actor_name
FROM numbered n
WHERE d.id = n.id;

-- Documents that already had an identity still need the register columns.
UPDATE warehouse_documents d
SET business_date = COALESCE(d.business_date, d.created_at::date),
    created_by_name = COALESCE(d.created_by_name, (SELECT u.full_name FROM users u WHERE u.id = d.created_by))
WHERE d.business_date IS NULL OR d.created_by_name IS NULL;

UPDATE retail_warehouse_documents d
SET business_date = COALESCE(d.business_date, d.created_at::date),
    created_by_name = COALESCE(d.created_by_name, (SELECT u.full_name FROM users u WHERE u.id = d.created_by))
WHERE d.business_date IS NULL OR d.created_by_name IS NULL;

-- Move the #922 branch+kind sequence past every backfilled number. The
-- sequence row is (business_id, location_id, kind) with `last_number`, and the
-- service allocates `last_number + 1`, so seeding the max suffix is enough.
INSERT INTO warehouse_voucher_sequences (business_id, location_id, kind, last_number)
SELECT d.business_id,
       d.location_id,
       d.kind::text,
       max(substring(d.internal_voucher_number from '([0-9]+)$')::int)
  FROM warehouse_documents d
 WHERE d.internal_voucher_number ~ '^[A-Z]+-[0-9]{4}-[0-9]+$'
 GROUP BY d.business_id, d.location_id, d.kind
ON CONFLICT (business_id, location_id, kind) DO UPDATE
   SET last_number = GREATEST(warehouse_voucher_sequences.last_number, EXCLUDED.last_number);

INSERT INTO warehouse_voucher_sequences (business_id, location_id, kind, last_number)
SELECT d.business_id,
       d.location_id,
       d.kind::text,
       max(substring(d.internal_voucher_number from '([0-9]+)$')::int)
  FROM retail_warehouse_documents d
 WHERE d.internal_voucher_number ~ '^[A-Z]+-[0-9]{4}-[0-9]+$'
 GROUP BY d.business_id, d.location_id, d.kind
ON CONFLICT (business_id, location_id, kind) DO UPDATE
   SET last_number = GREATEST(warehouse_voucher_sequences.last_number, EXCLUDED.last_number);

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
