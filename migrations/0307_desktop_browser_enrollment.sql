-- Issue #1115 §A.3 — browser-based enrollment of an *unpaired* Windows Hybrid
-- install.
--
-- The Windows app has no pairing code to type and no device identity yet, so
-- the Cloud must hold a short-lived reservation while the owner authorizes it
-- in the system browser. This table is that reservation:
--
--   * the app proves ownership of the request with a 32-byte secret it mints
--     locally and never sends — only its SHA-256 is stored here;
--   * the owner confirms in the browser, which issues an ordinary one-time
--     pairing code and seals it against this row. The code is never shown on
--     screen and never travels through a URL, log or redirect: it is returned
--     only to a caller that presents the device secret;
--   * the app then redeems that code through the existing two-phase pairing
--     path, so enrollment introduces no second identity system and no second
--     snapshot format.
--
-- `state = 'approved'` with no `pairing_code_ciphertext` is a brief, legitimate
-- in-flight state (the claim is taken before the code is minted, so that two
-- approvers cannot both mint one). A poll during that window answers `pending`
-- and never a code.
--
-- The minted code's id is recorded next to its ciphertext, so denial, expiry and
-- supersede retire that exact code. Codes are stored hashed, so an id is the
-- only way to name one without decrypting the sealed copy just to re-hash it.

CREATE TABLE desktop_enrollment_requests (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    installation_id         text NOT NULL CHECK (char_length(installation_id) BETWEEN 8 AND 200),
    device_name             text NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 120),
    device_secret_hash      text NOT NULL CHECK (char_length(device_secret_hash) = 64),
    -- Read out by the owner on screen, so it uses the pairing alphabet (no
    -- O/0 or I/1) and lives exactly as long as the reservation.
    user_code               text NOT NULL CHECK (char_length(user_code) = 8),
    max_snapshot_version    integer CHECK (max_snapshot_version IS NULL OR max_snapshot_version >= 0),
    state                   text NOT NULL DEFAULT 'pending'
                              CHECK (state IN ('pending', 'approved', 'denied', 'expired')),
    location_id             uuid REFERENCES locations(id) ON DELETE SET NULL,
    pairing_code_ciphertext text,
    -- The code sealed above, so revocation names it instead of re-deriving it.
    pairing_code_id         uuid REFERENCES install_pairing_codes(id) ON DELETE SET NULL,
    approved_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at             timestamptz,
    expires_at              timestamptz NOT NULL,
    last_polled_at          timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    CHECK (state <> 'denied' OR approved_at IS NOT NULL)
);
CREATE INDEX idx_desktop_enrollment_requests_live
  ON desktop_enrollment_requests (business_id, state, expires_at);
-- One live code per read-aloud value: a collision must be rejected, not shown
-- to two owners.
CREATE UNIQUE INDEX idx_desktop_enrollment_requests_user_code
  ON desktop_enrollment_requests (user_code) WHERE state = 'pending';

ALTER TABLE desktop_enrollment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE desktop_enrollment_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON desktop_enrollment_requests FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
