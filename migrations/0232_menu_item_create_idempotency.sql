-- ============================================================================
-- 0232_menu_item_create_idempotency.sql — issue #911: one save, one item.
--
-- «ذخیره» in the item sheet POSTs /api/menu/items. A double-click, a tapped
-- Enter, or a request whose answer the browser never received (timeout,
-- dropped connection, a reload mid-flight) all produced a SECOND identical
-- item: the sheet had a client-side in-flight guard, but nothing on the
-- server could tell a retry from a second, deliberate save.
--
-- This migration gives a create an optional, client-supplied key that the
-- database itself enforces:
--
--   * the column is nullable — every existing writer (the CSV importer, the
--     AI autopilot, WooCommerce sync, the Hybrid merge, data transfer) keeps
--     working untouched, and rows without a key are never deduplicated;
--   * the unique index is partial (`WHERE create_idempotency_key IS NOT
--     NULL`), so the infinite NULLs cost nothing and never collide;
--   * the index leads with location_id, matching every other menu_items
--     uniqueness rule (`uq_menu_items_location_sku`): the same key may be
--     reused in another branch, and a branch can never claim an item it does
--     not own.
--
-- The key is a *create* key, not a request cache: the server answers a replay
-- with the item that was already created (`duplicate: true`), so a retried
-- save is a no-op instead of a duplicate. It is deliberately NOT a general
-- mutation idempotency layer — a price change still has its own append-only
-- history and its own rules.
--
-- No RLS change: menu_items is already scoped through app_owns_location, and
-- a column cannot widen a row's visibility.
-- ============================================================================

ALTER TABLE menu_items
    ADD COLUMN IF NOT EXISTS create_idempotency_key text;

-- Length-bounded so an unbounded client string cannot bloat the index.
ALTER TABLE menu_items
    ADD CONSTRAINT IF NOT EXISTS ck_menu_items_create_idempotency_key_len
    CHECK (create_idempotency_key IS NULL OR char_length(create_idempotency_key) BETWEEN 1 AND 100);

CREATE UNIQUE INDEX IF NOT EXISTS uq_menu_items_location_create_key
    ON menu_items (location_id, create_idempotency_key)
 WHERE create_idempotency_key IS NOT NULL;
