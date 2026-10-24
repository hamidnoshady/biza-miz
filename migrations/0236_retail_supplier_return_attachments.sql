-- Supporting documents for retail supplier-return vouchers.
--
-- Attachments point at canonical Media Library assets; the composite foreign
-- keys keep both sides inside the same tenant even when a caller supplies a
-- valid UUID belonging to another business.
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_supplier_returns_business_id_id
    ON item_supplier_returns (business_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_assets_business_id_id
    ON media_assets (business_id, id);

CREATE TABLE item_supplier_return_attachments (
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    return_id      uuid NOT NULL,
    media_asset_id uuid NOT NULL,
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, return_id, media_asset_id),
    FOREIGN KEY (business_id, return_id)
        REFERENCES item_supplier_returns (business_id, id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, media_asset_id)
        REFERENCES media_assets (business_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_item_supplier_return_attachments_return
    ON item_supplier_return_attachments (business_id, return_id, created_at);

ALTER TABLE item_supplier_return_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_supplier_return_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_supplier_return_attachments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
