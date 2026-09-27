-- ============================================================================
-- 0176_media_ai_edit_variants.sql — three more lightweight, Cloudinary/Canva-
-- style AI operations beyond the existing paid 'enhanced' refine (migration
-- 0149) and the free local 'transformed' crop/rotate/resize (migration 0175):
-- background removal, upscale, and variations. Still explicitly NOT a full
-- image editor — each is one provider call producing a NEW derived asset,
-- never overwriting the source, exactly like 'enhanced' and 'transformed'
-- already do.
--
--   variant — widened again to accept 'bg_removed', 'upscaled', 'variation'
--             alongside the four existing values, so the grid/drawer can
--             tell every derived-asset kind apart.
-- ============================================================================

ALTER TABLE media_assets DROP CONSTRAINT media_assets_variant_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_variant_check
    CHECK (variant IN ('original', 'enhanced', 'transformed', 'bg_removed', 'upscaled', 'variation'));
