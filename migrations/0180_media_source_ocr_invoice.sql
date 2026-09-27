-- ============================================================================
-- 0180_media_source_ocr_invoice.sql — widens media_assets.source (already
-- widened once in 0178 for 'ocr_receipt') to also allow 'ocr_invoice': a
-- supplier-invoice photo stored by POST /api/ai/invoice-ocr on a successful
-- extraction (migration 0179 gives the resulting purchase draft a durable
-- pointer back to it). Distinct from 'ocr_receipt' — that is Accounting's
-- expense-receipt photo; this is Inventory's purchase-invoice photo — kept
-- as separate provenance values (not a single generic 'ocr' value) so the
-- library's source filter/badge can tell an accountant's receipt from a
-- purchaser's invoice at a glance, the same way it already distinguishes
-- 'ai_attachment' from both.
--
-- Same widen-a-CHECK-constraint shape as 0175/0176/0178: additive, no data
-- migrated (existing rows keep whatever `source` they already have), no RLS
-- change needed.
-- ============================================================================

ALTER TABLE media_assets DROP CONSTRAINT media_assets_source_check;

ALTER TABLE media_assets
    ADD CONSTRAINT media_assets_source_check
    CHECK (source IN ('upload', 'ai_attachment', 'ai_generated', 'ocr_receipt', 'ocr_invoice'));
