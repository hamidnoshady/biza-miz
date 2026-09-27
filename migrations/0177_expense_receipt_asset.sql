-- ============================================================================
-- 0177_expense_receipt_asset.sql — links an expense to the canonical Media
-- Library asset for the receipt photo it was recorded from, closing a named
-- gap in the Media architecture report: "invoices/receipts, OCR inputs" are
-- meant to live in the ONE canonical library like everything else, but the
-- expense-receipt OCR flow (both the AI Chat tool and the standalone
-- /api/ai/invoice-ocr route) never persisted the photo anywhere at all.
--
-- Nullable, ON DELETE SET NULL: an expense is a financial record that must
-- outlive the fate of its receipt photo (a purged/removed asset must never
-- cascade into losing or blocking a posted financial entry) — the reverse
-- direction (deleting/trashing the asset while an expense still points at it)
-- is guarded in application code (getMediaAssetUsage), the same "safe delete
-- needs a usage check" pattern menu_items/inventory_items already use via
-- image_media_id.
-- ============================================================================

ALTER TABLE expenses ADD COLUMN receipt_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL;

CREATE INDEX idx_expenses_receipt_asset ON expenses (receipt_asset_id) WHERE receipt_asset_id IS NOT NULL;
