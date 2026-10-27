-- Products workspace: publish status plus short and long descriptions on `items`.
--
-- WooCommerce and the website manager both describe a product with a publish
-- status (published / draft / private) and a short and a long description. The
-- accounting products screen is where those are authored, so the columns live
-- on the item itself — not in the Woo mirror — and the mirror only reads them.
--
--   * `publish_status` is a different axis from `is_active` (does this item
--     exist at all) and `is_sellable` (can the till ring it up): it says
--     whether the product is meant to be shown on a storefront. Default
--     'published' so every existing item keeps behaving exactly as before.
--   * both descriptions are plain text (no HTML); the website adapter turns
--     them into the target system's markup.
--
-- Additive and nullable/defaulted: no backfill, no rewrite of existing rows.
ALTER TABLE items
    ADD COLUMN IF NOT EXISTS publish_status text NOT NULL DEFAULT 'published',
    ADD COLUMN IF NOT EXISTS short_description text,
    ADD COLUMN IF NOT EXISTS long_description text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'items_publish_status_check'
    ) THEN
        ALTER TABLE items
            ADD CONSTRAINT items_publish_status_check
            CHECK (publish_status IN ('published', 'draft', 'private'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'items_short_description_length'
    ) THEN
        ALTER TABLE items
            ADD CONSTRAINT items_short_description_length
            CHECK (short_description IS NULL OR char_length(short_description) <= 1000);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'items_long_description_length'
    ) THEN
        ALTER TABLE items
            ADD CONSTRAINT items_long_description_length
            CHECK (long_description IS NULL OR char_length(long_description) <= 20000);
    END IF;
END $$;
