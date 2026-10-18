-- Migration 0229 — issue #984: support-only device identity and chunked artifacts.
--
-- The companion cannot borrow the main app's sync bearer token: that token is
-- sealed inside the main database's settings, exactly the database that may be
-- down when support is needed. So enrollment provisions an independent
-- support-device credential (separate audience, hash-only server storage,
-- DPAPI-sealed on the device), bound to one installation row. Enrollment is
-- owner-approved and never activates Hybrid transaction sync or bypasses
-- #974's activation gates — it only scopes support evidence/assistance.
--
-- Local-only installations have no site_devices row, so
-- support_installations.site_device_id becomes nullable; the composite FK
-- simply does not check NULL legs. Hybrid installations keep the verified
-- site-device binding.
--
-- Chunked artifact upload: encrypted report bytes travel in bounded chunks
-- (256 KiB, at most 32 per artifact = 8 MiB) and assemble server-side only
-- when the whole-body sha256 matches. Bytes stay in Postgres (bytea) for v1 —
-- no S3 dependency on site; a Central object store remains a documented
-- follow-up. `upload_state` distinguishes an interrupted upload (never shown
-- as available) from a verified one.

ALTER TABLE support_installations ALTER COLUMN site_device_id DROP NOT NULL;

-- ── Support device credentials (hash-only, staged rotation) ─────────────────

CREATE TABLE support_device_credentials (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    installation_id     uuid NOT NULL,
    -- sha256 hex of the bearer the companion presents. Globally unique so a
    -- presented credential resolves its tenant without trusting any id.
    credential_hash     text NOT NULL UNIQUE CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
    state               text NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active', 'staged', 'revoked')),
    valid_until         timestamptz,
    rotated_at          timestamptz,
    revoked_at          timestamptz,
    last_seen_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_device_credentials_installation_fk
      FOREIGN KEY (installation_id, business_id)
      REFERENCES support_installations(id, business_id) ON DELETE CASCADE
);
CREATE INDEX idx_support_device_credentials_hash
    ON support_device_credentials (credential_hash)
    WHERE revoked_at IS NULL;

-- ── Owner-approved enrollments (the pairing journal) ────────────────────────

CREATE TABLE support_enrollments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Bound at completion for local-only installs; pre-bound for hybrid.
    installation_id     uuid,
    site_device_id      uuid,
    -- sha256 hex of the short claim code shown once to the approving owner.
    claim_code_hash     text NOT NULL,
    claim_attempts      integer NOT NULL DEFAULT 0,
    state               text NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'claimed', 'expired', 'revoked')),
    approved_by         uuid,
    expires_at          timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_enrollments_installation_fk
      FOREIGN KEY (installation_id, business_id)
      REFERENCES support_installations(id, business_id) ON DELETE CASCADE
);
CREATE INDEX idx_support_enrollments_business ON support_enrollments (business_id, state, expires_at);

-- ── Chunked encrypted artifact bytes ────────────────────────────────────────
--
-- 0228 gave every support table UNIQUE(id, business_id) except
-- support_diagnostic_artifacts; backfill it (trivially satisfied — id is the
-- PK) so chunks can bind with a composite foreign key.

ALTER TABLE support_diagnostic_artifacts
    ADD CONSTRAINT uq_support_diagnostic_artifacts_id_business UNIQUE (id, business_id);

CREATE TABLE support_artifact_chunks (
    artifact_id         uuid NOT NULL,
    business_id         uuid NOT NULL,
    chunk_index         integer NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 32),
    chunk_hash          text NOT NULL CHECK (chunk_hash ~ '^[0-9a-f]{64}$'),
    bytes               bytea NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (artifact_id, chunk_index),
    CONSTRAINT support_artifact_chunks_artifact_fk
      FOREIGN KEY (artifact_id, business_id)
      REFERENCES support_diagnostic_artifacts(id, business_id) ON DELETE CASCADE
);

ALTER TABLE support_diagnostic_artifacts
    ADD COLUMN upload_state text NOT NULL DEFAULT 'uploading'
        CHECK (upload_state IN ('uploading', 'available', 'rejected')),
    ADD COLUMN chunk_count integer NOT NULL DEFAULT 0,
    ADD COLUMN payload bytea,
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- ── Same-migration RLS ──────────────────────────────────────────────────────

ALTER TABLE support_device_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_device_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_device_credentials FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_enrollments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_enrollments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_artifact_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_artifact_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_artifact_chunks FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
