-- ============================================================================
-- 0203_menu_item_price_history.sql — issue #844: canonical price history.
--
-- `menu_items.price` was a plain mutable column: the manual menu editor, the
-- CSV importer, the AI `menu.item.priceUpdate` action, the WooCommerce product
-- sync and the Hybrid master merge all wrote it directly, so any two writers
-- silently overwrote each other and nothing could answer «این قیمت کی و چرا
-- عوض شد؟». Closed orders were never wrong — every order line snapshots its
-- own sale price — but the *catalogue* had no memory.
--
-- This table is that memory: append-only, one row per actual change, written
-- atomically with the current-price update by src/lib/menu-price-service.ts —
-- the single service every writer is routed through. `menu_items.price` stays
-- the fast current selling price; history is a separate operational/audit
-- concern and never rewrites historical invoices.
--
--   old = new → no row (a no-op PATCH is not a price change).
--
-- `source` is populated by the server from the calling path, never from a
-- request body, so a client cannot relabel a manual edit as a migration or an
-- import. The Persian labels live in src/lib/menu-price-service.ts and the
-- audit action label in src/lib/audit.ts.
--
-- RLS in the same migration, per repo convention: rows are scoped through the
-- branch they belong to (app_owns_location), exactly like menu_items itself.
-- ============================================================================

CREATE TABLE menu_item_price_history (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Denormalised for RLS and for per-branch history screens.
    location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    menu_item_id    uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    old_price_rial  bigint NOT NULL CHECK (old_price_rial >= 0),
    new_price_rial  bigint NOT NULL CHECK (new_price_rial >= 0),
    -- When the new price takes effect (default: now). A backdated change is
    -- possible for an operator correcting yesterday's price; changed_at is
    -- always the moment the row was written.
    effective_from  timestamptz NOT NULL DEFAULT now(),
    changed_at      timestamptz NOT NULL DEFAULT now(),
    -- text, not a users FK: some writers have no interactive user (a
    -- background sync), and MCP writes name their authorizing connection.
    changed_by      text,
    -- manual | suggested | import | ai | integration | sync | migration
    source          text NOT NULL CHECK (source IN
                        ('manual', 'suggested', 'import', 'ai',
                         'integration', 'sync', 'migration')),
    -- Which audit row / connection / file produced the change, when one exists.
    source_ref      text,
    reason          text,
    note            text
);

-- The history screen reads (branch, time desc) and per-item latest changes.
CREATE INDEX idx_menu_item_price_history_location_time
    ON menu_item_price_history (location_id, changed_at DESC);
CREATE INDEX idx_menu_item_price_history_item_time
    ON menu_item_price_history (menu_item_id, changed_at DESC);
CREATE INDEX idx_menu_item_price_history_source
    ON menu_item_price_history (location_id, source, changed_at DESC);

ALTER TABLE menu_item_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_price_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_item_price_history FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

-- Append-only, enforced by the database rather than by promising every writer
-- will behave: history that can be updated or deleted is just another mutable
-- table. UPDATE/DELETE/TRUNCATE all raise; INSERT is the only verb.
CREATE OR REPLACE FUNCTION app_menu_item_price_history_append_only()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'menu_item_price_history is append-only'
        USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER menu_item_price_history_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON menu_item_price_history
    FOR EACH ROW EXECUTE FUNCTION app_menu_item_price_history_append_only();
