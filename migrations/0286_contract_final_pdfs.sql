-- #908 — immutable, Media Library-backed final PDFs with public hash verification.
-- The QR token is stored only as a SHA-256 digest; the final PDF asset is
-- protected from Media Library trash/purge through its durable usage reference.

ALTER TABLE media_assets DROP CONSTRAINT media_assets_source_check;
ALTER TABLE media_assets
    ADD CONSTRAINT media_assets_source_check
    CHECK (source IN ('upload', 'ai_attachment', 'ai_generated', 'ocr_receipt', 'ocr_invoice', 'contract_final_pdf'));

ALTER TABLE contract_document_versions
    ADD CONSTRAINT contract_document_versions_business_contract_id_unique
    UNIQUE (business_id, contract_id, id);
ALTER TABLE media_assets
    ADD CONSTRAINT media_assets_business_id_unique
    UNIQUE (business_id, id);

CREATE TABLE contract_final_pdfs (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    contract_id           uuid NOT NULL,
    document_version_id   uuid NOT NULL,
    media_asset_id        uuid NOT NULL,
    content_hash          text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    pdf_sha256            text NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
    verification_token_hash text NOT NULL UNIQUE CHECK (verification_token_hash ~ '^[0-9a-f]{64}$'),
    signature_count       integer NOT NULL CHECK (signature_count > 0),
    created_by            text NOT NULL DEFAULT '',
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT contract_final_pdfs_one_per_version UNIQUE (document_version_id),
    CONSTRAINT contract_final_pdfs_version_tenant_fk
      FOREIGN KEY (business_id, contract_id, document_version_id)
      REFERENCES contract_document_versions (business_id, contract_id, id) ON DELETE RESTRICT,
    CONSTRAINT contract_final_pdfs_media_tenant_fk
      FOREIGN KEY (business_id, media_asset_id)
      REFERENCES media_assets (business_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_contract_final_pdfs_tenant_contract
    ON contract_final_pdfs (business_id, contract_id, created_at DESC);

ALTER TABLE contract_final_pdfs ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_final_pdfs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contract_final_pdfs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
CREATE POLICY contract_final_pdfs_append_only_no_update ON contract_final_pdfs AS RESTRICTIVE FOR UPDATE
    USING (false);
CREATE POLICY contract_final_pdfs_append_only_no_delete ON contract_final_pdfs AS RESTRICTIVE FOR DELETE
    USING (false);

COMMENT ON TABLE contract_final_pdfs IS
  'Immutable association between a completed frozen contract version and its Media Library PDF, with token-only QR verification.';
