-- ============================================================================
-- 0178_media_source_ocr_receipt.sql — widens media_assets.source (added in
-- 0161_media_asset_provenance.sql, CHECK-constrained to 'upload' /
-- 'ai_attachment' / 'ai_generated') to also allow 'ocr_receipt': a receipt
-- photo stored by POST /api/ai/receipt-ocr (migration 0177 gives the
-- resulting expense a durable pointer back to it). Distinct from
-- 'ai_attachment' — that is a photo a person dropped into an AI Chat turn;
-- this is a photo submitted specifically for metered OCR extraction, with no
-- chat turn involved at all — the Media Library's own provenance filter
-- ("از گفت‌وگو" vs. a receipt) would otherwise misreport it as a chat
-- attachment it never was.
--
-- Same widen-a-CHECK-constraint shape as 0175/0176 widening
-- media_assets_variant_check: additive, no data migrated (existing rows keep
-- whatever `source` they already have), no RLS change needed.
-- ============================================================================

ALTER TABLE media_assets DROP CONSTRAINT media_assets_source_check;

ALTER TABLE media_assets
    ADD CONSTRAINT media_assets_source_check
    CHECK (source IN ('upload', 'ai_attachment', 'ai_generated', 'ocr_receipt'));
