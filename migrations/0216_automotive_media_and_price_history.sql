-- ============================================================================
-- 0216_automotive_media_and_price_history.sql — complete price snapshots and
-- canonical Media Library links for vehicle files (issue #839).
--
-- The bytes remain owned by `media_assets` (0149). This table stores only a
-- tenant-safe relationship and its business label; uploads, storage keys,
-- quotas, duplicate detection and serving continue through the shared media
-- service. Pricing history is extended forward-only so every future change can
-- preserve both sides of every editable price field.
-- ============================================================================

ALTER TABLE automotive_vehicle_price_history
    ADD COLUMN previous_minimum_price_rial bigint,
    ADD COLUMN previous_wholesale_price_rial bigint,
    ADD COLUMN previous_promotional_price_rial bigint;

ALTER TABLE automotive_vehicle_price_history
    ADD CONSTRAINT automotive_price_history_previous_minimum_nonnegative
        CHECK (previous_minimum_price_rial IS NULL OR previous_minimum_price_rial >= 0),
    ADD CONSTRAINT automotive_price_history_previous_wholesale_nonnegative
        CHECK (previous_wholesale_price_rial IS NULL OR previous_wholesale_price_rial >= 0),
    ADD CONSTRAINT automotive_price_history_previous_promotional_nonnegative
        CHECK (previous_promotional_price_rial IS NULL OR previous_promotional_price_rial >= 0);

-- Composite keys make the tenant boundary structural in both directions;
-- simple id FKs would allow a programming error to attach another tenant's
-- asset or vehicle while still passing the database constraints.
CREATE UNIQUE INDEX uq_automotive_vehicle_business_serial
    ON automotive_vehicle_attributes (business_id, serial_id);
CREATE UNIQUE INDEX uq_media_assets_business_id
    ON media_assets (business_id, id);

CREATE TABLE automotive_vehicle_media (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL,
    serial_id        uuid NOT NULL,
    media_asset_id   uuid NOT NULL,
    category         text NOT NULL DEFAULT 'photo'
                         CHECK (category IN ('photo', 'registration', 'inspection', 'service_record', 'invoice', 'other')),
    title            text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
    description      text,
    display_order    integer NOT NULL DEFAULT 0 CHECK (display_order >= 0),
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT automotive_vehicle_media_vehicle_fk
        FOREIGN KEY (business_id, serial_id)
        REFERENCES automotive_vehicle_attributes (business_id, serial_id) ON DELETE CASCADE,
    CONSTRAINT automotive_vehicle_media_asset_fk
        FOREIGN KEY (business_id, media_asset_id)
        REFERENCES media_assets (business_id, id) ON DELETE CASCADE,
    CONSTRAINT automotive_vehicle_media_one_link
        UNIQUE (business_id, serial_id, media_asset_id)
);

CREATE INDEX idx_automotive_vehicle_media_vehicle
    ON automotive_vehicle_media (business_id, serial_id, display_order, created_at DESC);
CREATE INDEX idx_automotive_vehicle_media_asset
    ON automotive_vehicle_media (business_id, media_asset_id);

ALTER TABLE automotive_vehicle_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE automotive_vehicle_media FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automotive_vehicle_media FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
