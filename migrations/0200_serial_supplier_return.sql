-- Issue #795 Phase 2 — supplier returns must identify exact serials.
--
-- A serialized unit sent back to its supplier is a terminal lifecycle
-- state of that exact physical unit: it is no longer sellable, never
-- deleted (its provenance/audit history stays), and must be visibly
-- distinct from `sold`. The status CHECK gains `supplier_returned`;
-- `validateSerialStatusTransition` (src/lib/items.ts) makes it terminal.
-- (`item_supplier_return_items.serial_id` already exists — migration 0084
-- anticipated exact-serial returns; this completes the lifecycle side.)
ALTER TABLE item_serials DROP CONSTRAINT item_serials_status_check;
ALTER TABLE item_serials ADD CONSTRAINT item_serials_status_check
  CHECK (status IN ('in_stock', 'reserved', 'sold', 'in_repair', 'supplier_returned'));
