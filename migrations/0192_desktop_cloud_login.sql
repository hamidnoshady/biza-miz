-- Phase 46: «ورود با حساب ابری» — one-click sign-in on a paired desktop.
--
-- The owner presses the button on the desktop, signs in to the cloud in the
-- system browser, and the cloud hands the browser back to the app with a
-- single-use code. Two kinds of code live here, both short-lived and claimed
-- with a conditional UPDATE (never a read-then-write):
--
--   device  — minted by the signed-in cloud user for one paired site device;
--             redeemed by that device's bearer credential (server-to-server),
--             which is what signs the same member in on the desktop.
--   session — minted at that redemption; redeemed once by the desktop's
--             embedded cloud pane on the business's own origin, which is what
--             signs the pane in without a second password.
--
-- Only a SHA-256 of a code is stored. `state` binds a device code to the
-- desktop window that asked for it (the desktop checks it against a cookie
-- before redeeming), so a link nobody on that desktop requested signs nobody in.

CREATE TABLE desktop_login_codes (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind           text NOT NULL CHECK (kind IN ('device', 'session')),
    code_hash      text NOT NULL UNIQUE CHECK (char_length(code_hash) = 64),
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    site_device_id uuid REFERENCES site_devices(id) ON DELETE CASCADE,
    state          text,
    expires_at     timestamptz NOT NULL,
    used_at        timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (kind = 'session' OR (site_device_id IS NOT NULL AND state IS NOT NULL))
);
CREATE INDEX idx_desktop_login_codes_expiry ON desktop_login_codes (business_id, expires_at);

ALTER TABLE desktop_login_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE desktop_login_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON desktop_login_codes FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
