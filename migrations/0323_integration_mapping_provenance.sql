-- ============================================================================
-- 0323_integration_mapping_provenance.sql — issue #1592 (ESH-234)
--
-- Why this exists
-- ---------------
-- `integration_mappings` is keyed on (connection_id, entity_type, remote_id)
-- and cascades when an `integration_connections` row is physically deleted.
-- The application's "disconnect" is already a soft delete (`deleted_at`), so
-- mappings survive a normal disconnect — but a direct DELETE (admin repair,
-- restore tooling, an older client) still erases the only evidence that a
-- local item ever came from a store. That is exactly the provenance gap behind
-- the August-vs-September duplicates: the older rows exist, their mappings do
-- not, and the store connection that created them is gone.
--
-- What this adds (additive, backward compatible)
-- ----------------------------------------------
--   1. `integration_mapping_provenance`: an append-only snapshot of a
--      connection row and every mapping it owned, written by a BEFORE DELETE
--      trigger. The cascade still removes the live mappings (no behaviour
--      change for existing code); the evidence is preserved and readable.
--   2. `archive_connection_mapping_provenance()` as SECURITY DEFINER so the
--      trigger can write the snapshot even when the deleting role has no direct
--      INSERT grant on the table.
--   3. Tenant-isolated, forced RLS on the new table (same policy shape as
--      `integration_mappings`), so the snapshot is never cross-tenant readable.
--
-- Rollback
-- --------
--   DROP TRIGGER integration_connections_archive_mappings ON integration_connections;
--   DROP FUNCTION archive_connection_mapping_provenance();
--   DROP TABLE integration_mapping_provenance;
-- No live table, mapping, item or document is modified by this migration.
-- ============================================================================

CREATE TABLE IF NOT EXISTS integration_mapping_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  entity_type text NOT NULL,
  remote_id text NOT NULL,
  local_id uuid,
  mapping_created_at timestamptz,
  archived_at timestamptz NOT NULL DEFAULT now(),
  archived_reason text NOT NULL DEFAULT 'connection_deleted',
  -- Everything an operator needs to understand the link without the deleted
  -- connection row: provider, store URL, connection name and its id.
  connection_snapshot jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mapping_provenance_business
  ON integration_mapping_provenance (business_id, archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_mapping_provenance_connection
  ON integration_mapping_provenance (business_id, connection_id);
CREATE INDEX IF NOT EXISTS idx_mapping_provenance_remote
  ON integration_mapping_provenance (business_id, entity_type, remote_id);

ALTER TABLE integration_mapping_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_mapping_provenance FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON integration_mapping_provenance;
CREATE POLICY tenant_isolation ON integration_mapping_provenance
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE OR REPLACE FUNCTION archive_connection_mapping_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO integration_mapping_provenance (
    business_id, connection_id, entity_type, remote_id, local_id,
    mapping_created_at, archived_reason, connection_snapshot
  )
  SELECT m.business_id,
         m.connection_id,
         m.entity_type,
         m.remote_id,
         m.local_id,
         m.created_at,
         'connection_deleted',
         jsonb_build_object(
           'id', OLD.id,
           'name', OLD.name,
           'provider', OLD.provider,
           'baseUrl', OLD.base_url,
           'pluginSiteUrl', OLD.plugin_site_url,
           'createdAt', OLD.created_at,
           'deletedAt', OLD.deleted_at
         )
    FROM integration_mappings m
    -- A tenant deletion cascades businesses -> connections: by the time this
    -- trigger runs the business row may already be gone, so there is no tenant
    -- to keep evidence for (and the FK would reject the snapshot). Only a
    -- connection deleted while its business still exists is archived.
    JOIN businesses b ON b.id = m.business_id
   WHERE m.connection_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS integration_connections_archive_mappings ON integration_connections;
CREATE TRIGGER integration_connections_archive_mappings
  BEFORE DELETE ON integration_connections
  FOR EACH ROW EXECUTE FUNCTION archive_connection_mapping_provenance();

COMMENT ON TABLE integration_mapping_provenance IS
  'Issue #1592: append-only evidence of integration mappings owned by a physically deleted connection. Soft deletes keep live mappings; this table only fills on DELETE.';
