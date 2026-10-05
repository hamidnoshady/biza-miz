-- Hybrid login credential plane: its own durable sync state, next to (never
-- inside) `iam_sync_state`.
--
-- `iam_sync_state` answers one question — do this site's memberships and roles
-- equal the cloud's? Login credentials travel on a separate endpoint
-- (`/api/iam/login-credentials`, migration-era PR #837) because the IAM
-- snapshot is metadata-only, and a site can therefore be perfectly converged
-- on memberships while every cloud-created PIN is still missing locally. That
-- partial state used to be invisible: the roster simply omitted the member.
-- This table makes the credential sub-stage observable in its own right:
-- identity/membership health and credential health are read separately and
-- only together do they mean "fully converged identity".
CREATE TABLE iam_login_credential_sync_state (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  site_device_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'healthy','pending','syncing','degraded','unsupported_legacy_cloud','snapshot_required','repair_required'
  )),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  -- "How much arrived" — the cloud records in the last accepted payload.
  credentials_received integer NOT NULL DEFAULT 0 CHECK (credentials_received >= 0),
  pins_received integer NOT NULL DEFAULT 0 CHECK (pins_received >= 0),
  -- "How much was written" — PIN rows actually applied and identities linked.
  pins_applied integer NOT NULL DEFAULT 0 CHECK (pins_applied >= 0),
  identities_applied integer NOT NULL DEFAULT 0 CHECK (identities_applied >= 0),
  -- "How much still does not add up": active PIN-role memberships this site
  -- expects to see on the quick-login roster, how many of them can actually
  -- sign in, and how many password-role members still lack the replicated
  -- global identity (`users.platform_user_id`).
  pin_members_expected integer NOT NULL DEFAULT 0 CHECK (pin_members_expected >= 0),
  pin_members_usable integer NOT NULL DEFAULT 0 CHECK (pin_members_usable >= 0),
  pin_members_missing integer NOT NULL DEFAULT 0 CHECK (pin_members_missing >= 0),
  missing_identity_bindings integer NOT NULL DEFAULT 0 CHECK (missing_identity_bindings >= 0),
  converged_at timestamptz,
  PRIMARY KEY (business_id, site_device_id),
  FOREIGN KEY (site_device_id, business_id) REFERENCES site_devices(id, business_id) ON DELETE CASCADE
);

-- Existing paired sites have never run the credential stage; recording that
-- explicitly stops the upgrade window from claiming healthy credentials for a
-- site whose PIN staff are about to be reconciled by the next sync tick.
INSERT INTO iam_login_credential_sync_state (business_id, site_device_id, status, last_error)
SELECT business_id, id, 'pending', 'credential_sync_not_yet_run'
FROM site_devices
WHERE status = 'active'
ON CONFLICT DO NOTHING;

ALTER TABLE iam_login_credential_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam_login_credential_sync_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON iam_login_credential_sync_state
  FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE iam_login_credential_sync_state IS
  'Hybrid login-credential convergence per paired site: durable health of the /api/iam/login-credentials stage, separate from iam_sync_state so membership health cannot masquerade as login health.';
