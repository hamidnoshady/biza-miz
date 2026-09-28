-- Dedicated IAM control plane for Cloud-authoritative Hybrid sites.
-- Security state is ordered per business; it never shares the operational
-- sync_events stream and is never reconciled by timestamp/last-write-wins.

ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_revision bigint NOT NULL DEFAULT 1 CHECK (membership_revision > 0);
ALTER TABLE tenant_roles ADD COLUMN IF NOT EXISTS role_revision bigint NOT NULL DEFAULT 1 CHECK (role_revision > 0);

ALTER TABLE users ADD CONSTRAINT users_business_id_id_iam_unique UNIQUE (business_id, id);

-- Credentials now live in employee_credentials and may be established after a
-- Hybrid replica membership is inserted. The legacy row-shape check made a
-- credential-less canonical replica impossible and encouraged copying Cloud hashes.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_credentials;

-- Canonicalize legacy PINs without invalidating an installation during the
-- rollout. Readers retain a users.pin_hash fallback for databases that have
-- not reached this migration; after this transaction commits, this database
-- has one revocable active credential per member and no duplicate hash copy.
INSERT INTO employees (id, business_id)
SELECT id, business_id FROM users WHERE pin_hash IS NOT NULL
ON CONFLICT (id) DO NOTHING;
INSERT INTO employee_credentials
  (employee_id, business_id, credential_type, secret_hash)
SELECT u.id, u.business_id, 'pin', u.pin_hash
  FROM users u
 WHERE u.pin_hash IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM employee_credentials ec
      WHERE ec.employee_id = u.id AND ec.business_id = u.business_id
        AND ec.credential_type = 'pin' AND ec.status = 'active'
   );
UPDATE users u SET pin_hash = NULL
 WHERE pin_hash IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM employee_credentials ec
      WHERE ec.employee_id = u.id AND ec.business_id = u.business_id
        AND ec.credential_type = 'pin' AND ec.status = 'active'
   );

CREATE TABLE iam_business_sequences (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);

CREATE TABLE iam_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('membership','tenant_role','credential')),
  entity_id uuid NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  payload jsonb NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  origin text NOT NULL CHECK (origin IN ('cloud','local','site_command','migration')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, sequence)
);
CREATE INDEX iam_events_business_sequence_idx ON iam_events (business_id, sequence);
CREATE INDEX iam_events_entity_idx ON iam_events (business_id, entity_type, entity_id, sequence DESC);

CREATE TABLE iam_sync_state (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  site_device_id uuid NOT NULL,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_snapshot_version bigint NOT NULL DEFAULT 0 CHECK (last_snapshot_version >= 0),
  last_snapshot_hash text,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  status text NOT NULL DEFAULT 'snapshot_required' CHECK (status IN ('healthy','pending','syncing','degraded','conflict','snapshot_required','offline')),
  last_error text,
  PRIMARY KEY (business_id, site_device_id),
  FOREIGN KEY (site_device_id, business_id) REFERENCES site_devices(id, business_id) ON DELETE CASCADE
);

CREATE TABLE iam_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  site_device_id uuid NOT NULL,
  command_id uuid NOT NULL,
  command_type text NOT NULL,
  membership_id uuid,
  expected_revision bigint CHECK (expected_revision IS NULL OR expected_revision > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','conflict')),
  result jsonb,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (business_id, site_device_id, command_id),
  FOREIGN KEY (site_device_id, business_id) REFERENCES site_devices(id, business_id) ON DELETE CASCADE
);
CREATE INDEX iam_commands_pending_idx ON iam_commands (business_id, site_device_id, status, created_at);

CREATE TABLE iam_dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  site_device_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  error_code text NOT NULL,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','discarded')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, site_device_id, sequence),
  FOREIGN KEY (site_device_id, business_id) REFERENCES site_devices(id, business_id) ON DELETE CASCADE
);

-- A site overlay can only deny/narrow. There is deliberately no permission_grants
-- column. NULL allowed_location_ids means no additional branch restriction.
CREATE TABLE site_member_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  site_device_id uuid NOT NULL,
  user_id uuid NOT NULL,
  allowed_location_ids uuid[],
  permission_denies jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(permission_denies) = 'array'),
  is_locally_suspended boolean NOT NULL DEFAULT false,
  local_login_locked boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, site_device_id, user_id),
  FOREIGN KEY (site_device_id, business_id) REFERENCES site_devices(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, business_id) REFERENCES users(id, business_id) ON DELETE CASCADE
);
CREATE INDEX site_member_access_user_idx ON site_member_access (business_id, user_id, site_device_id);

-- Existing paired sites must repair from a canonical IAM snapshot before IAM
-- events are trusted. Local-only installations have no site device and remain untouched.
INSERT INTO iam_sync_state (business_id, site_device_id, status, last_error)
SELECT business_id, id, 'snapshot_required', 'legacy_pairing_requires_iam_snapshot'
FROM site_devices
WHERE status = 'active'
ON CONFLICT DO NOTHING;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['iam_business_sequences','iam_events','iam_sync_state','iam_commands','iam_dead_letters','site_member_access'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL USING (app_rls_bypass() OR business_id = app_current_business()) WITH CHECK (app_rls_bypass() OR business_id = app_current_business())', t);
  END LOOP;
END $$;

COMMENT ON TABLE iam_events IS 'Ordered, versioned security control-plane stream; separate from operational sync_events.';
COMMENT ON TABLE site_member_access IS 'Hybrid site deny-only access overlay. Canonical membership fields are never overwritten by machine restrictions.';
