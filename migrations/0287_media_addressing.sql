-- Preserve the addressing used by all existing media writes; no data rewrite.
ALTER TABLE platform_media_config
  ADD COLUMN IF NOT EXISTS force_path_style boolean NOT NULL DEFAULT true;
-- The old previous_force_path_style defaulted to false but the media client
-- never used it. NULL in this new field means legacy path-style fallback.
ALTER TABLE platform_media_config
  ADD COLUMN IF NOT EXISTS previous_media_force_path_style boolean;
