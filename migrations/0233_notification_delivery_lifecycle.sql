-- Existing unbound subscriptions cannot safely survive a shared-device handoff.
ALTER TABLE notification_devices ADD COLUMN session_id uuid REFERENCES employee_sessions(id) ON DELETE SET NULL;
UPDATE notification_devices SET disabled_at = COALESCE(disabled_at, now()), last_error = 'registration_required';
ALTER TABLE notification_events ADD COLUMN lease_until timestamptz;
ALTER TABLE notification_deliveries ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE notification_deliveries ADD COLUMN lease_until timestamptz;
ALTER TABLE notification_deliveries ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE notification_deliveries ADD COLUMN batch_id uuid;
CREATE INDEX notification_delivery_queue ON notification_deliveries(business_id, available_at) WHERE status = 'queued';

CREATE TABLE notification_preferences (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'digest' CHECK (mode IN ('immediate', 'digest', 'inapp')),
  timezone text,
  digest_minutes integer NOT NULL DEFAULT 5 CHECK (digest_minutes BETWEEN 1 AND 60),
  -- Separate tenant, user and device durable budgets; never process-local.
  PRIMARY KEY (business_id, user_id)
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_preferences FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Each scope is a separate row: one tenant cannot consume another's budget.
CREATE TABLE notification_push_budgets (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  scope text NOT NULL,
  next_at timestamptz NOT NULL,
  PRIMARY KEY (business_id, scope)
);
ALTER TABLE notification_push_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_push_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_push_budgets FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Revoking this login ends only its own registrations, not other devices.
CREATE FUNCTION notification_revoke_session_devices() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    UPDATE notification_devices SET disabled_at=now(),last_error='session_revoked'
      WHERE session_id=NEW.id AND business_id=NEW.business_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_session_revoked AFTER UPDATE OF revoked_at ON employee_sessions
  FOR EACH ROW EXECUTE FUNCTION notification_revoke_session_devices();

-- Native FCM uses the same queue/budgets, not a second direct-send path (#884).
ALTER TABLE notification_deliveries ALTER COLUMN device_id DROP NOT NULL;
ALTER TABLE notification_deliveries ADD COLUMN native_device_id uuid REFERENCES native_app_devices(id) ON DELETE CASCADE;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_delivery_device_shape CHECK ((device_id IS NULL) <> (native_device_id IS NULL));
CREATE UNIQUE INDEX notification_delivery_native_event ON notification_deliveries(event_id,native_device_id) WHERE native_device_id IS NOT NULL;

ALTER TABLE notification_push_budgets ADD COLUMN used integer NOT NULL DEFAULT 0;
ALTER TABLE notification_push_budgets ADD COLUMN window_start timestamptz NOT NULL DEFAULT now();
-- Stable batch identity is for presentation; a different token fences each lease attempt.
ALTER TABLE notification_deliveries ADD COLUMN lease_token uuid;
ALTER TABLE notification_devices ADD COLUMN last_failure_at timestamptz;
