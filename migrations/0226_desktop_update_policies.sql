-- 0226_desktop_update_policies.sql
--
-- Central, versioned Desktop update policy (issue #981). Layers resolve
-- platform → business → location → device; each layer stores only the keys it
-- explicitly overrides, so the console can show inherited vs overridden values.
--
-- Not a second updater: release selection, signing and the device engine are
-- unchanged. This only adds *who decides* per business/site/device.
--
-- Every write draws `version` from one global sequence, so a policy version
-- only ever grows, even when an override is cleared (a clear writes an empty
-- patch at a new version instead of deleting the row). A device that has seen
-- version N can therefore refuse an older document: policy rollback is not
-- replayable.

CREATE SEQUENCE desktop_update_policy_seq;

-- Deployment-wide defaults. A singleton with no business_id, the same shape as
-- platform_releases: tenant data does not live here.
CREATE TABLE platform_desktop_update_policy (
    id          boolean PRIMARY KEY DEFAULT true CHECK (id),
    policy      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(policy) = 'object'),
    version     bigint NOT NULL DEFAULT 0,
    reason      text,
    updated_by  uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_desktop_update_policy (id) VALUES (true);

CREATE TABLE business_desktop_update_policies (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    scope           text NOT NULL CHECK (scope IN ('business', 'location', 'device')),
    location_id     uuid,
    site_device_id  uuid,
    policy          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(policy) = 'object'),
    version         bigint NOT NULL,
    reason          text,
    updated_by      uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT business_desktop_update_policies_scope_shape CHECK (
      (scope = 'business' AND location_id IS NULL AND site_device_id IS NULL) OR
      (scope = 'location' AND location_id IS NOT NULL AND site_device_id IS NULL) OR
      (scope = 'device'   AND site_device_id IS NOT NULL AND location_id IS NULL)
    ),
    CONSTRAINT business_desktop_update_policies_location_fk
      FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE CASCADE,
    CONSTRAINT business_desktop_update_policies_device_fk
      FOREIGN KEY (site_device_id, business_id) REFERENCES site_devices(id, business_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_business_desktop_update_policy_business
  ON business_desktop_update_policies (business_id) WHERE scope = 'business';
CREATE UNIQUE INDEX uq_business_desktop_update_policy_location
  ON business_desktop_update_policies (business_id, location_id) WHERE scope = 'location';
CREATE UNIQUE INDEX uq_business_desktop_update_policy_device
  ON business_desktop_update_policies (business_id, site_device_id) WHERE scope = 'device';

ALTER TABLE business_desktop_update_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_desktop_update_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_desktop_update_policies FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Delivery acknowledgement: the policy version a device reports it has applied.
-- "Requested" is the layer write; "delivered" is the response that carried the
-- document; "acknowledged" is this column catching up to it.
ALTER TABLE site_device_runtime_status
  ADD COLUMN acknowledged_policy_version bigint CHECK (acknowledged_policy_version IS NULL OR acknowledged_policy_version >= 0),
  ADD COLUMN acknowledged_policy_at      timestamptz,
  ADD COLUMN delivered_policy_version    bigint,
  ADD COLUMN delivered_policy_at         timestamptz;
