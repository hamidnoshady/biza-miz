-- 0311_certificate_free_release_manifests.sql
--
-- Issue #1463. Desktop releases can now be authenticated by a signed release
-- manifest plus SHA-256/size instead of a mandatory Windows Authenticode
-- certificate. Schema 1 rows keep their publisher pin; schema 2 rows carry the
-- signing algorithm, key id, monotonic release sequence and platform identity.
-- Authenticode stays available as optional defense-in-depth (`signature_required`).

ALTER TABLE platform_releases
  ALTER COLUMN expected_publisher DROP NOT NULL,
  ALTER COLUMN signature_required SET DEFAULT false,
  ADD COLUMN manifest_schema_version integer NOT NULL DEFAULT 1
    CONSTRAINT platform_releases_manifest_schema CHECK (manifest_schema_version IN (1, 2)),
  ADD COLUMN signature_algorithm text
    CONSTRAINT platform_releases_signature_algorithm CHECK (
      signature_algorithm IS NULL OR signature_algorithm IN ('ed25519', 'rsa-sha256')
    ),
  ADD COLUMN signing_key_id text,
  ADD COLUMN release_sequence bigint
    CONSTRAINT platform_releases_release_sequence CHECK (release_sequence IS NULL OR release_sequence > 0),
  ADD COLUMN platform text,
  ADD COLUMN architecture text,
  ADD COLUMN manifest_expires_at timestamptz;

ALTER TABLE platform_releases
  ADD CONSTRAINT platform_releases_manifest_identity CHECK (
    (manifest_schema_version = 1 AND expected_publisher IS NOT NULL AND signature_required = true)
    OR
    (manifest_schema_version = 2 AND signature_algorithm IS NOT NULL AND signing_key_id IS NOT NULL
      AND release_sequence IS NOT NULL AND platform IS NOT NULL AND architecture IS NOT NULL)
  );

CREATE INDEX idx_platform_releases_sequence
  ON platform_releases (channel, release_sequence DESC)
  WHERE manifest_schema_version = 2;
