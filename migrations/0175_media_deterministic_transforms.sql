-- ============================================================================
-- 0175_media_deterministic_transforms.sql — lightweight, non-destructive image
-- operations (crop / rotate / resize), the "Cloudinary/Canva-style" tier the
-- audit asked for — explicitly NOT a full image editor.
--
-- These are deterministic, local (sharp) operations with no AI provider call
-- and therefore no wallet cost, unlike the existing 'enhanced' variant (the
-- paid AI refine, migration 0149). They reuse the exact same non-destructive
-- pattern: the result is a NEW asset row with `source_asset_id` pointing back
-- at the asset it was derived from, so the original is never overwritten.
--
--   variant       — widened to accept 'transformed' alongside the existing
--                   'original' / 'enhanced', so the library grid and the
--                   asset drawer can tell "AI-refined" and "cropped/rotated/
--                   resized" apart instead of conflating them.
--   transform_ops — which operation(s) produced this asset and their
--                   parameters, e.g. [{"operation":"crop","params":{...}}] —
--                   provenance for the version history UI, not something any
--                   query filters on (hence jsonb, no index).
-- ============================================================================

ALTER TABLE media_assets DROP CONSTRAINT media_assets_variant_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_variant_check
    CHECK (variant IN ('original', 'enhanced', 'transformed'));

ALTER TABLE media_assets
    ADD COLUMN transform_ops jsonb NOT NULL DEFAULT '[]'::jsonb;
