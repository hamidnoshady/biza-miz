-- ============================================================================
-- 0181_party_profile_image_asset.sql — lets a party's profile photo be a real
-- canonical Media Library asset instead of only an inline base64 `data:` URL
-- stuffed into `parties.profile_image` (migration 0137).
--
-- This is additive, not a replacement: `profile_image` keeps every row it
-- already has (an existing `data:` URL avatar, or an `https://` linked one)
-- and stays the column an external link is stored in going forward. A new
-- upload from the party form instead becomes a Media Library asset and is
-- linked here, so a fresh avatar is deduplicated, storage-orphan-reconciled
-- and safe-delete-checked the same way a menu item's photo already is,
-- instead of a second, un-managed image store living inside the parties
-- table. Application code (`normalizePartyWrite`, parties-service.ts) is
-- what enforces the two being mutually exclusive on a given write — the
-- schema itself just holds both, so old rows are never touched or migrated
-- by force.
--
-- Nullable, ON DELETE SET NULL: a party is a directory/ledger record that
-- must outlive the fate of its own avatar photo — the same reasoning 0177
-- used for expenses.receipt_asset_id and 0179 for purchases.invoice_asset_id.
-- The reverse direction (deleting/trashing the asset while a party still
-- points at it) is guarded in application code via getMediaAssetUsage,
-- extended here with a fourth category.
-- ============================================================================

ALTER TABLE parties ADD COLUMN profile_image_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL;

CREATE INDEX idx_parties_profile_image_asset ON parties (profile_image_asset_id) WHERE profile_image_asset_id IS NOT NULL;
