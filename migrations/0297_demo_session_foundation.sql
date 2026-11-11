-- The migration is shared with production. Only a separately provisioned Demo
-- database receives COMMENT ON DATABASE ... IS 'bizamiz-demo:<uuid>' from its owner.
CREATE FUNCTION app_demo_database_id() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT substring(shobj_description(oid, 'pg_database') FROM
    '^bizamiz-demo:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$')
  FROM pg_database WHERE datname = current_database();
$$;

ALTER TABLE businesses DROP CONSTRAINT businesses_ownership_kind_check;
ALTER TABLE businesses ADD CONSTRAINT businesses_ownership_kind_check
  CHECK (ownership_kind IN ('customer', 'platform_internal', 'demo'));

CREATE FUNCTION protect_demo_business() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ownership_kind = 'demo'
       AND (NOT app_rls_bypass() OR app_demo_database_id() IS NULL) THEN
      RAISE EXCEPTION 'demo_database_required' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (OLD.ownership_kind = 'demo' OR NEW.ownership_kind = 'demo')
       AND (OLD.ownership_kind, OLD.industry) IS DISTINCT FROM (NEW.ownership_kind, NEW.industry) THEN
      RAISE EXCEPTION 'demo_classification_immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.ownership_kind = 'demo'
        AND (NOT app_rls_bypass() OR app_demo_database_id() IS NULL) THEN
    RAISE EXCEPTION 'demo_database_required' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_demo_business
BEFORE INSERT OR UPDATE OF ownership_kind, industry OR DELETE ON businesses
FOR EACH ROW EXECUTE FUNCTION protect_demo_business();

CREATE TABLE platform_demo_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  location_id uuid NOT NULL,
  platform_user_id uuid NOT NULL REFERENCES platform_users(id) DEFERRABLE INITIALLY DEFERRED,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  industry text NOT NULL,
  template_version text NOT NULL CHECK (template_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  provisioning_state text NOT NULL CHECK (provisioning_state IN ('provisioning', 'ready')),
  cleanup_state text NOT NULL DEFAULT 'pending' CHECK (cleanup_state IN ('pending', 'running', 'failed', 'complete')),
  CHECK (expires_at = created_at + interval '60 minutes'),
  FOREIGN KEY (business_id, user_id) REFERENCES users(business_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX platform_demo_sessions_cleanup_due ON platform_demo_sessions (expires_at) WHERE cleanup_state <> 'complete';

ALTER TABLE platform_demo_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_demo_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_demo_sessions FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE FUNCTION protect_demo_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_rls_bypass() OR app_demo_database_id() IS NULL THEN
    RAISE EXCEPTION 'demo_database_required' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM businesses b
    JOIN users u ON u.business_id = b.id AND u.id = NEW.user_id
    JOIN locations l ON l.id = NEW.location_id AND l.business_id = b.id AND l.is_active
    JOIN user_locations ul ON ul.user_id = u.id AND ul.location_id = l.id
    JOIN platform_users p ON p.id = u.platform_user_id
    WHERE b.id = NEW.business_id AND b.ownership_kind = 'demo' AND b.industry = NEW.industry
      AND b.status = 'active'
      AND u.role = 'owner' AND u.is_active AND u.membership_status = 'active' AND p.id = NEW.platform_user_id AND NOT p.is_active
  ) THEN
    RAISE EXCEPTION 'invalid_demo_session_binding' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (OLD.id, OLD.business_id, OLD.user_id, OLD.location_id, OLD.platform_user_id,
      OLD.token_hash, OLD.industry, OLD.template_version, OLD.created_at, OLD.expires_at)
    IS DISTINCT FROM
    (NEW.id, NEW.business_id, NEW.user_id, NEW.location_id, NEW.platform_user_id,
      NEW.token_hash, NEW.industry, NEW.template_version, NEW.created_at, NEW.expires_at)
    OR (OLD.revoked_at IS NOT NULL AND OLD.revoked_at IS DISTINCT FROM NEW.revoked_at)
  ) THEN
    RAISE EXCEPTION 'demo_session_binding_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_demo_session
BEFORE INSERT OR UPDATE OR DELETE ON platform_demo_sessions
FOR EACH ROW EXECUTE FUNCTION protect_demo_session();

-- Tenant archive replay sets session_replication_role to replica.
ALTER TABLE businesses ENABLE ALWAYS TRIGGER protect_demo_business;
ALTER TABLE platform_demo_sessions ENABLE ALWAYS TRIGGER protect_demo_session;
