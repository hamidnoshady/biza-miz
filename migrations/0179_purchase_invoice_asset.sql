-- ============================================================================
-- 0179_purchase_invoice_asset.sql — links a draft purchase to the canonical
-- Media Library asset for the supplier-invoice photo it was scanned from,
-- mirroring 0177's expenses.receipt_asset_id for the parallel invoice-OCR
-- flow (POST /api/ai/invoice-ocr → the purchases draft form). Closes the
-- storage half of the "invoice-OCR still ephemeral by original design" gap
-- disclosed in the Media Library report: the extraction/matching logic was
-- already real, but the invoice photo itself was never kept anywhere.
--
-- Nullable, ON DELETE SET NULL: a purchase is a stock/financial record that
-- must outlive the fate of its invoice photo — the same reasoning 0177 used
-- for expenses.receipt_asset_id. The reverse direction (deleting/trashing the
-- asset while a purchase still points at it) is guarded in application code
-- via getMediaAssetUsage, extended here with a third-plus category.
-- ============================================================================

ALTER TABLE purchases ADD COLUMN invoice_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL;

CREATE INDEX idx_purchases_invoice_asset ON purchases (invoice_asset_id) WHERE invoice_asset_id IS NOT NULL;
