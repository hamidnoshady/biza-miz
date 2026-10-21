-- Remote attachment state, not a second file store. Tombstones survive mirror
-- pruning and allow deletion to arrive before the push's first confirmation.
CREATE TABLE integration_wp_media_state (
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    remote_id text NOT NULL,
    revision numeric(20,0) NOT NULL CHECK (revision >= 0),
    deleted boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (connection_id, remote_id),
    FOREIGN KEY (connection_id, business_id) REFERENCES integration_connections(id, business_id) ON DELETE CASCADE
);
ALTER TABLE integration_wp_media_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_wp_media_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_wp_media_state FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE integration_wp_media_snapshots (
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    generation uuid NOT NULL,
    boundary numeric(20,0) NOT NULL CHECK (boundary > 0),
    expected_count integer CHECK (expected_count BETWEEN 0 AND 500000),
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY (connection_id, generation),
    UNIQUE (connection_id, generation, business_id),
    FOREIGN KEY (connection_id, business_id) REFERENCES integration_connections(id, business_id) ON DELETE CASCADE
);
CREATE TABLE integration_wp_media_snapshot_members (
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    generation uuid NOT NULL,
    remote_id text NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 500000),
    PRIMARY KEY (connection_id, generation, remote_id),
    UNIQUE (connection_id, generation, ordinal),
    FOREIGN KEY (connection_id, generation, business_id) REFERENCES integration_wp_media_snapshots(connection_id, generation, business_id) ON DELETE CASCADE
);
ALTER TABLE integration_wp_media_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_wp_media_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_wp_media_snapshots FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
ALTER TABLE integration_wp_media_snapshot_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_wp_media_snapshot_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_wp_media_snapshot_members FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
CREATE INDEX integration_wp_media_cursor ON integration_wp_content (connection_id, created_at DESC, id DESC) WHERE wp_type = 'attachment';

-- Preserve the existing shared queue's full allowlist while adding the single
-- capability-negotiated, non-creation attachment command transport.
DO $$
DECLARE definition text;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
      WHERE conrelid = 'integration_outbox_events'::regclass AND conname = 'integration_outbox_events_entity_type_check';
    IF definition IS NULL THEN RAISE EXCEPTION 'outbox entity constraint missing'; END IF;
    ALTER TABLE integration_outbox_events DROP CONSTRAINT integration_outbox_events_entity_type_check;
    EXECUTE 'ALTER TABLE integration_outbox_events ADD CONSTRAINT integration_outbox_events_entity_type_check ' ||
      regexp_replace(definition, '^CHECK \(', 'CHECK (entity_type = ''media_update'' OR ');
END $$;

ALTER TABLE integration_connections ADD COLUMN last_media_sync_at timestamptz;
