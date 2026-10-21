-- #934: disconnect retains the parent and all audit/mapping/inbox/outbox and
-- reconciliation history. No automatic purge; tenant erasure remains separate.
ALTER TABLE integration_connections
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN last_test_at timestamptz,
  ADD COLUMN last_successful_test_at timestamptz,
  ADD COLUMN last_test_error text;

-- Prevent an accidental parent deletion from silently erasing audit history.
-- NO ACTION (deferred to statement end) still permits whole-tenant erasure.
ALTER TABLE integration_audit_log
  DROP CONSTRAINT integration_audit_log_connection_id_fkey,
  ADD CONSTRAINT integration_audit_log_connection_id_fkey
    FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE NO ACTION;

-- Existing historical inconsistencies must be repaired deliberately, not by
-- dropping connections. NOT VALID enforces all new assignments immediately.
ALTER TABLE integration_connections
  DROP CONSTRAINT integration_connections_location_id_fkey,
  ADD CONSTRAINT integration_connections_location_business_fk
    FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id)
    ON DELETE NO ACTION NOT VALID;

-- Tombstones are credential-free and cannot be resurrected by an old worker.
ALTER TABLE integration_connections
  DROP CONSTRAINT integration_connections_mode_credentials,
  ADD CONSTRAINT integration_connections_mode_credentials CHECK (
    deleted_at IS NOT NULL OR provider = 'holoo' OR link_mode = 'plugin'
    OR (consumer_key_ciphertext IS NOT NULL AND consumer_secret_ciphertext IS NOT NULL)
  ),
  DROP CONSTRAINT integration_connections_plugin_token,
  ADD CONSTRAINT integration_connections_plugin_token CHECK (
    deleted_at IS NOT NULL OR link_mode <> 'plugin'
    OR (link_token_hash IS NOT NULL AND link_token_ciphertext IS NOT NULL)
  ),
  ADD CONSTRAINT integration_connections_tombstone CHECK (
    deleted_at IS NULL OR (
      status = 'paused' AND consumer_key_ciphertext IS NULL AND consumer_secret_ciphertext IS NULL
      AND wp_username_ciphertext IS NULL AND wp_application_password_ciphertext IS NULL
      AND link_token_hash IS NULL AND link_token_ciphertext IS NULL
    )
  );

CREATE FUNCTION integration_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (app_factory_reset_active()
      OR NOT EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'integration_audit_append_only' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER trg_integration_audit_append_only
  BEFORE UPDATE OR DELETE ON integration_audit_log
  FOR EACH ROW EXECUTE FUNCTION integration_audit_append_only();
