-- ============================================================================
-- 0234_woo_taxonomy_state.sql — issue #939
-- The taxonomy mirror learns to say what it knows, and what it failed to learn.
--
-- Before this, "the store's taxonomy tree" existed only as rows in
-- `integration_woo_terms`. That made three honest answers impossible:
--
--   1. A taxonomy the store really has but that is *empty* (or whose read
--      failed) had no rows, so the manager screen could not distinguish it
--      from a taxonomy that was never discovered — the group simply vanished
--      (audit TAX-14).
--   2. A sync that failed halfway still let the catalogue stamp
--      `last_catalogue_sync_at` and clear `last_error`, so a store with a
--      broken custom taxonomy reported a healthy, complete mirror (TAX-04).
--   3. A late plugin snapshot — a retried queue row carrying an older view of
--      the tree — could restore terms a newer snapshot had already deleted,
--      because nothing recorded *which* moment a mirror reflected (TAX-15).
--
-- One row per (connection, canonical taxonomy slug) fixes all three: the
-- group exists before its terms do, its status says synced/truncated/failed,
-- and `snapshot_at` is the watermark a stale snapshot is refused against.
--
-- The second table stages a taxonomy snapshot the plugin had to split into
-- chunks because a single event would have exceeded the push byte limit.
-- Chunks are inert until the last one arrives; only a complete, validated,
-- non-stale set ever becomes a `replaceTerms` write (TAX-03/TAX-15).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- What the mirror knows about each taxonomy it has seen
-- ---------------------------------------------------------------------------
CREATE TABLE integration_woo_taxonomy_state (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    -- The canonical taxonomy slug — 'product_cat', 'pa_color', 'brand'.
    -- Always the identity, even when the store lists its terms under a
    -- different `rest_base` (TAX-09): the slug keys the mirror, the
    -- rest_base only ever routes an HTTP request.
    taxonomy      text NOT NULL CHECK (char_length(taxonomy) BETWEEN 1 AND 190),
    rest_base     text NOT NULL DEFAULT '',
    -- 'pending'  discovered, never successfully read
    -- 'synced'   the mirror holds the complete tree as of snapshot_at
    -- 'truncated' stored, but the store sent more than the mirror keeps
    -- 'failed'   the last read errored; terms may be stale or absent
    status        text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'synced', 'truncated', 'failed')),
    term_count    integer NOT NULL DEFAULT 0 CHECK (term_count >= 0),
    last_error    text,
    -- Set only by a *successful* snapshot application. The screen's
    -- «آخرین همگام‌سازی موفق» is this, not the blended catalogue stamp.
    last_synced_at timestamptz,
    -- The remote moment this mirror reflects: the plugin's `generated_at`
    -- for pushed snapshots, the read time for REST pulls. A snapshot older
    -- than this is refused, which is what keeps a replayed queue row from
    -- resurrecting terms a newer snapshot deleted.
    snapshot_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_id, taxonomy),
    CONSTRAINT integration_woo_taxonomy_state_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_integration_woo_taxonomy_state_connection
    ON integration_woo_taxonomy_state (connection_id);

-- ---------------------------------------------------------------------------
-- Staging for a chunked plugin snapshot
--
-- The app refuses a request body over 2 MB, and one queue row is one body.
-- A taxonomy with tens of thousands of terms does not fit one event, so the
-- plugin splits the snapshot into numbered chunks sharing a `snapshot_id`.
-- Chunks land here; when the set is complete the ingest assembles it,
-- validates it, applies it through the same transactional `replaceTerms`
-- path a single-event snapshot uses, and clears the stage. An incomplete
-- set never touches the mirror — a truncated transport must not read as a
-- complete-empty taxonomy (TAX-03).
-- ---------------------------------------------------------------------------
CREATE TABLE integration_woo_taxonomy_snapshot_chunks (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    taxonomy      text NOT NULL CHECK (char_length(taxonomy) BETWEEN 1 AND 190),
    snapshot_id   text NOT NULL CHECK (char_length(snapshot_id) BETWEEN 1 AND 100),
    chunk_index   integer NOT NULL CHECK (chunk_index >= 0),
    chunk_count   integer NOT NULL CHECK (chunk_count >= 2),
    terms         jsonb NOT NULL DEFAULT '[]'::jsonb,
    generated_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_id, taxonomy, snapshot_id, chunk_index),
    CONSTRAINT integration_woo_taxonomy_snapshot_chunks_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_integration_woo_taxonomy_snapshot_chunks_lookup
    ON integration_woo_taxonomy_snapshot_chunks (connection_id, taxonomy, snapshot_id);

-- ---------------------------------------------------------------------------
-- A taxonomy-only export job
--
-- «همگام‌سازی از وب‌سایت» on the taxonomy screen, in plugin mode. The
-- existing answer was `catalogue_export` — a full product sweep — which is
-- a sledgehammer for "re-send me the category tree" and cannot run at all
-- while the owner has products sync off. Capability negotiation still
-- gates it: an older plugin that never advertised `taxonomy_export` is
-- offered `catalogue_export` instead rather than a job it would never lease.
-- ---------------------------------------------------------------------------
ALTER TABLE integration_outbox_events
    DROP CONSTRAINT IF EXISTS integration_outbox_events_entity_type_check;
ALTER TABLE integration_outbox_events
    ADD CONSTRAINT integration_outbox_events_entity_type_check
        CHECK (entity_type IN (
            'stock', 'price', 'catalogue_export', 'customer_export',
            'holoo_sale', 'holoo_receipt', 'holoo_purchase',
            'product_update',
            'order_status',
            'refund_create',
            'orders_export',
            'content_export',
            'post_upsert',
            'media_create',
            -- issue #939: re-send the taxonomy tree only.
            'taxonomy_export'
        ));

-- ---------------------------------------------------------------------------
-- RLS — the standard template
-- ---------------------------------------------------------------------------
ALTER TABLE integration_woo_taxonomy_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_woo_taxonomy_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_woo_taxonomy_state FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE integration_woo_taxonomy_snapshot_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_woo_taxonomy_snapshot_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_woo_taxonomy_snapshot_chunks FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
