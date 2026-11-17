-- 0301_platform_release_publisher_thumbprint.sql
--
-- Issue #1000. A Desktop release now pins the exact Authenticode signing
-- certificate, not only a publisher display name. The value travels inside the
-- RSA-signed release manifest and is enforced by the Desktop update engine, so
-- certificate rotation is an explicit new signed release rather than something
-- the device infers from whatever certificate it happens to inspect.
--
-- Nullable on purpose: releases registered before thumbprint pinning existed
-- keep their rows, and NULL means "no pin recorded", never "accept any
-- certificate" — the device refuses a manifest without a pin.

ALTER TABLE platform_releases
  ADD COLUMN expected_publisher_thumbprint text
  CONSTRAINT platform_releases_publisher_thumbprint_format CHECK (
    expected_publisher_thumbprint IS NULL OR expected_publisher_thumbprint ~ '^[0-9A-F]{40}$'
  );
