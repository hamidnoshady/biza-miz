-- ============================================================================
-- 0216_native_app_devices.sql — Issue #884 follow-up: the Android app's
-- device registry.
--
-- Owner decisions (ISSUE_884_PLAN.md):
--   1. Owners and a member holding `native_devices.manage` may see/revoke
--      every device in the business; everyone else may see/revoke only their
--      own (the server derives the user from the session, never a client
--      claim — see src/lib/native-device-service.ts).
--   2. Registration is a POST from an authenticated web session, carrying the
--      installation identity the Android app generated on first launch and
--      handed over through the `device.identity` bridge command. It is an
--      upsert keyed on (business_id, install_id) — a reinstall or a repeat
--      login must not create a second row — but it NEVER revives a revoked
--      row: a revoked installation must be reactivated by an owner/admin
--      before it can register again.
--   3. Revoking a device ends the authenticated access that installation
--      obtained through it: the row's session binding
--      (SessionPayload.nativeDeviceId, checked live by checkNativeDevice in
--      auth.ts, the same shape employee_sessions already has) stops
--      resolving the moment this row's revoked_at is set, which is what
--      denies every further business API request from that installation —
--      not a header or a bridge round trip, which an offline device could
--      simply not make.
--
-- Deliberately its own table, not pos_devices (migration 0044): a POS
-- terminal token narrows a public login picker before any session exists;
-- this is the opposite relationship — a member's own installation, bound
-- to an *already authenticated* session, never itself a login credential. A
-- shared table would mean pos_devices' "replace the login picker's offer"
-- read, and the login-roster queries that assume every row in it predates
-- authentication, would need their own device-less branch. Two tables also
-- means a Trusted Web Activity's device registry and a till's biometric
-- terminal registry can be revoked, listed and audited independently, which
-- is what they product-are: a cashier's lost phone and the restaurant's
-- card-reader terminal are not the same security event.
-- ============================================================================

CREATE TABLE native_app_devices (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The member whose session registered this installation. Not the only
    -- session ever bound to it (a logout/login cycle re-registers under
    -- whichever member is authenticated at the time), but the one a plain
    -- member's own device list is scoped to.
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform          text NOT NULL DEFAULT 'android' CHECK (platform IN ('android')),
    app_environment   text NOT NULL CHECK (app_environment IN ('development', 'staging', 'production')),
    -- The app's own persistent installation identity (TwaLauncherActivity's
    -- InstallationId, a UUID kept in app-private storage). Not a bearer
    -- credential — nothing is authorised by presenting it alone, the caller
    -- must already hold an authenticated session — so it is stored as given,
    -- the same way a push-subscription endpoint is.
    install_id        text NOT NULL CHECK (char_length(install_id) BETWEEN 8 AND 128),
    app_version_name  text NOT NULL CHECK (char_length(app_version_name) BETWEEN 1 AND 32),
    app_version_code  integer NOT NULL CHECK (app_version_code >= 1),
    bridge_version    integer NOT NULL CHECK (bridge_version >= 1),
    registered_at     timestamptz NOT NULL DEFAULT now(),
    last_seen_at      timestamptz,
    revoked_at        timestamptz,
    revoked_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    reactivated_at    timestamptz,
    reactivated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT native_app_devices_id_business_unique UNIQUE (id, business_id),
    -- One row per installation per business. A reinstall gets a new
    -- install_id (app-private storage is wiped with the app), so it is
    -- correctly a new row, not a reactivation of the old one.
    CONSTRAINT native_app_devices_business_install_unique UNIQUE (business_id, install_id)
);

CREATE INDEX idx_native_app_devices_business_active
    ON native_app_devices (business_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_native_app_devices_user
    ON native_app_devices (business_id, user_id);

ALTER TABLE native_app_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE native_app_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON native_app_devices FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
