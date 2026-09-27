-- ============================================================================
-- 0174_media_library_phase2.sql — Media Library, phase 2: trash, collections,
-- and a WordPress↔canonical-media mapping.
--
-- Three additive, backward-compatible extensions to the Media Library (0149).
-- No existing column changes type or loses data; every new column is
-- nullable or defaulted, so every asset that exists today keeps its exact
-- current meaning.
--
--   1. Soft delete ("trash") — media_assets.deleted_at. A library delete now
--      lands here first: the row (and its usage-reference safety check) stay
--      exactly as they were, but a "soft" delete only stamps deleted_at and
--      keeps the object in storage, recoverable, until an operator empties
--      the trash (a real removal) or a retention sweep purges it after N
--      days. Every list/lookup is updated in the service layer to exclude
--      deleted_at IS NOT NULL by default; nothing here changes ON DELETE FK
--      behaviour (image_media_id remains SET NULL on the eventual hard purge).
--
--   2. Collections — media_collections + media_collection_items. A folder is
--      a tree position an asset holds exactly one of; a collection is a named
--      ad hoc set an asset can belong to any number of (or none), with no
--      tree position of its own — the "این‌ها همه برای کمپین تابستانه‌اند"
--      grouping the original audit called out as functionally distinct from
--      both folders and tags (a tag is a free-text label; a collection is a
--      first-class, renamable, listable object with its own membership).
--
--   3. wordpress_media_mapping — which canonical media_assets row a given
--      WooCommerce/WordPress connection's remote attachment corresponds to,
--      so pushing a library asset out to a connected store never re-uploads
--      the same file twice, and the UI can show "already on your site" /
--      link straight to the WordPress attachment. This is additive: it does
--      not change how wp-manager's existing media mirror or outbox works,
--      it gives the (new) library-driven push path a durable place to record
--      the link once the plugin confirms it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Trash
-- ---------------------------------------------------------------------------
ALTER TABLE media_assets
    ADD COLUMN deleted_at timestamptz NULL;

-- Every hot list/read path filters "not in trash"; index it so that filter
-- is free rather than a sequential re-check of every row.
CREATE INDEX idx_media_assets_not_deleted
    ON media_assets (business_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_media_assets_trash
    ON media_assets (business_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Collections — a named set, distinct from a folder's single tree slot
-- ---------------------------------------------------------------------------
CREATE TABLE media_collections (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    description text CHECK (description IS NULL OR char_length(description) <= 500),
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, name)
);

ALTER TABLE media_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_collections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_collections FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE media_collection_items (
    collection_id uuid NOT NULL REFERENCES media_collections(id) ON DELETE CASCADE,
    asset_id      uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    -- Denormalized from the collection row so RLS can check this table
    -- directly without a join — the same pattern order_items (business_id
    -- absent, scoped through orders) deliberately does NOT use, because here
    -- the extra column costs nothing and keeps the policy a one-liner.
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    added_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    added_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (collection_id, asset_id)
);
CREATE INDEX idx_media_collection_items_asset ON media_collection_items (asset_id);

ALTER TABLE media_collection_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_collection_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_collection_items FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. WordPress mapping — canonical asset ↔ one connection's remote attachment
-- ---------------------------------------------------------------------------
CREATE TABLE wordpress_media_mapping (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
    -- The outbox operation id (integration_outbox_events.operation_id) that
    -- requested the push, so a retried/duplicate enqueue can find the same
    -- mapping row instead of creating a second one before the plugin confirms.
    operation_id  text NOT NULL,
    -- Filled in once the plugin's add_attachment webhook confirms the file
    -- landed on the WordPress site; NULL while the push is still in flight.
    wp_media_id   text NULL,
    wp_url        text NULL,
    status        text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'synced', 'failed')),
    last_error    text NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    synced_at     timestamptz NULL,
    -- One canonical asset maps to at most one remote attachment per
    -- connection — re-pushing the same asset updates this row, never adds a
    -- second copy on the WordPress side.
    UNIQUE (connection_id, media_asset_id)
);
CREATE INDEX idx_wp_media_mapping_asset ON wordpress_media_mapping (media_asset_id);
CREATE INDEX idx_wp_media_mapping_operation ON wordpress_media_mapping (operation_id);

ALTER TABLE wordpress_media_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE wordpress_media_mapping FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wordpress_media_mapping FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
