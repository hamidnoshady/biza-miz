-- 0236_desktop_update_commands.sql
-- Durable, tenant-bound pull commands for the existing Desktop updater (#981).
-- Commands contain no executable URL or verification bypass. They only ask the
-- existing engine to re-check its authenticated target or start its verified
-- download path. Delivery and execution are intentionally distinct.

CREATE SEQUENCE desktop_update_command_seq;

CREATE TABLE desktop_update_commands (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    site_device_id      uuid NOT NULL,
    sequence            bigint NOT NULL DEFAULT nextval('desktop_update_command_seq'),
    command             text NOT NULL CHECK (command IN ('recheck', 'download_now')),
    status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','delivered','acknowledged','executed','verified','failed','expired')),
    idempotency_key     text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
    reason              text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
    requested_by        uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    requested_at        timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,
    delivered_at        timestamptz,
    acknowledged_at     timestamptz,
    executed_at         timestamptz,
    verified_at         timestamptz,
    failed_at           timestamptz,
    result              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT desktop_update_commands_device_business_fk
      FOREIGN KEY (site_device_id, business_id)
      REFERENCES site_devices(id, business_id) ON DELETE CASCADE,
    CONSTRAINT desktop_update_commands_expiry CHECK (expires_at > requested_at),
    CONSTRAINT desktop_update_commands_idempotent UNIQUE (business_id, site_device_id, idempotency_key),
    CONSTRAINT desktop_update_commands_sequence UNIQUE (site_device_id, sequence)
);
CREATE INDEX idx_desktop_update_commands_delivery
  ON desktop_update_commands (business_id, site_device_id, sequence)
  WHERE status IN ('queued','delivered','acknowledged');
CREATE INDEX idx_desktop_update_commands_fleet
  ON desktop_update_commands (business_id, requested_at DESC);

ALTER TABLE desktop_update_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE desktop_update_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON desktop_update_commands FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
