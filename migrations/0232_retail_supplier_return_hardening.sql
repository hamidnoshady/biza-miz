-- Issue #918 — harden the retail supplier-return voucher (حواله بازگشت).
--
-- What this migration adds, and why:
--
-- 1. `item_supplier_returns.supplier_id` — the explicit supplier of a return
--    that has no historical purchase behind it. A purchase-linked return keeps
--    resolving its supplier through `purchase_id → item_purchases.supplier_id`
--    (the canonical AP attribution in src/lib/ap-attribution.ts); an unlinked
--    return settled against accounts payable or a supplier receivable must name
--    its supplier explicitly instead of posting a faceless AP debit. The
--    service rejects an AP/supplier-receivable return whose resolved supplier
--    is null, and rejects an explicit supplier that disagrees with the linked
--    purchase's supplier.
--
-- 2. `request_fingerprint` — the canonical payload hash bound to the client's
--    idempotency key. Same key + same payload replays the original voucher;
--    same key + changed payload is a 409 conflict, never a silent second
--    voucher (the ap_payments `request_fingerprint` pattern).
--
-- 3. `supplier_credit_rial` / `variance_rial` — the supplier credit (what the
--    settlement account is debited) is no longer silently the inventory
--    carrying value relieved (`total_value_rial` keeps that meaning). When a
--    linked purchase's invoice cost and the current carrying cost differ, the
--    posting relieves inventory at carrying value, credits the supplier at
--    invoice value, and books the variance to سایر هزینه‌ها/سایر درآمدها
--    (5900/4900). Legacy rows are backfilled with credit = carrying
--    (variance 0), which is exactly what their two-line postings did.
--
-- 4. `return_number` — the per-business sequential voucher number the register
--    prints, backed by `item_supplier_return_counters` (the
--    ar_ap_voucher_counters pattern). Legacy rows are numbered in creation
--    order.
--
-- 5. `status` — `posted` for every return this migration knows; a future
--    reversing operation will move a voucher to `reversed` rather than editing
--    or deleting it. Posted records are immutable.
--
-- 6. `item_supplier_return_items.purchase_item_id` — the exact receipt line a
--    linked return line relieves, so per-line return ceilings are enforceable
--    when one purchase received the same SKU at different costs. Legacy rows
--    keep NULL and are ceiling-checked at the (purchase, item) level.
--
-- 7. `item_supplier_return_items.supplier_credit_rial` — the per-line supplier
--    credit; `value_rial` keeps meaning the inventory carrying value relieved.
--
-- 8. `item_serials.purchase_id` — the purchase a serialized unit was received
--    under, so a linked return can prove the unit came from the purchase it
--    names (backfilled from single-unit purchase lines; multi-unit legacy
--    lines keep NULL and fall back to an item-level check).

ALTER TABLE item_supplier_returns
    ADD COLUMN supplier_id uuid REFERENCES suppliers(id) ON DELETE RESTRICT,
    ADD COLUMN request_fingerprint text,
    ADD COLUMN supplier_credit_rial bigint NOT NULL DEFAULT 0 CHECK (supplier_credit_rial >= 0),
    ADD COLUMN variance_rial bigint NOT NULL DEFAULT 0,
    ADD COLUMN return_number bigint,
    ADD COLUMN status text NOT NULL DEFAULT 'posted'
        CHECK (status IN ('posted', 'reversed'));

-- Legacy postings debited the settlement account for the same amount they
-- relieved inventory at, so credit = carrying backfills them exactly.
UPDATE item_supplier_returns
   SET supplier_credit_rial = total_value_rial,
       variance_rial = 0
 WHERE supplier_credit_rial = 0 AND (total_value_rial <> 0 OR supplier_credit_rial IS NULL);

CREATE TABLE item_supplier_return_counters (
    business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);

ALTER TABLE item_supplier_return_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_supplier_return_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_supplier_return_counters FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Number legacy vouchers in the order they were created, per business.
WITH numbered AS (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY business_id ORDER BY created_at, id) AS n
      FROM item_supplier_returns
)
UPDATE item_supplier_returns r
   SET return_number = numbered.n
  FROM numbered
 WHERE numbered.id = r.id;

ALTER TABLE item_supplier_returns ALTER COLUMN return_number SET NOT NULL;
ALTER TABLE item_supplier_returns
    ADD CONSTRAINT uq_item_supplier_returns_business_number UNIQUE (business_id, return_number);

INSERT INTO item_supplier_return_counters (business_id, last_number)
SELECT business_id, COALESCE(MAX(return_number), 0)
  FROM item_supplier_returns
 GROUP BY business_id
ON CONFLICT (business_id) DO UPDATE SET last_number = EXCLUDED.last_number;

CREATE INDEX idx_item_supplier_returns_supplier ON item_supplier_returns (supplier_id);
CREATE INDEX idx_item_supplier_returns_purchase ON item_supplier_returns (purchase_id);
CREATE INDEX idx_item_supplier_returns_location ON item_supplier_returns (location_id);

ALTER TABLE item_supplier_return_items
    ADD COLUMN purchase_item_id uuid REFERENCES item_purchase_items(id) ON DELETE RESTRICT,
    ADD COLUMN supplier_credit_rial bigint NOT NULL DEFAULT 0 CHECK (supplier_credit_rial >= 0);

UPDATE item_supplier_return_items
   SET supplier_credit_rial = value_rial
 WHERE supplier_credit_rial = 0 AND value_rial <> 0;

CREATE INDEX idx_item_supplier_return_items_purchase_item ON item_supplier_return_items (purchase_item_id);
CREATE INDEX idx_item_supplier_return_items_item ON item_supplier_return_items (item_id);

ALTER TABLE item_serials
    ADD COLUMN purchase_id uuid REFERENCES item_purchases(id) ON DELETE SET NULL;

-- Single-unit purchase lines point at the exact unit they created; multi-unit
-- legacy lines (serial_id NULL) cannot be attributed unit-by-unit and keep
-- NULL, which the service treats with an item-level fallback check.
UPDATE item_serials s
   SET purchase_id = pi.purchase_id
  FROM item_purchase_items pi
 WHERE pi.serial_id = s.id
   AND s.purchase_id IS NULL;

CREATE INDEX idx_item_serials_purchase ON item_serials (purchase_id);
