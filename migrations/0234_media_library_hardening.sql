-- Issue #926 — Media library hardening:
--   1. Enforce same-tenant foreign keys on media_assets(business_id, folder_id),
--      media_assets(business_id, source_asset_id), and
--      media_folders(business_id, parent_id).
--   2. Add safe storage migration state/fallback columns + audit tables
--      (platform_media_migrations, platform_media_orphan_scans) on the
--      superadmin media control plane.
--   3. Add retail catalogue media references (items.image_media_id cover/variant
--      column + ordered item_media gallery table under RLS).
--   4. Track media_assets and item_media in continuous hybrid master sync so
--      soft-delete (deleted_at), restore, and purge propagate cleanly to paired
--      sites without re-exposing trashed assets on reconnect.

SELECT set_config('app.rls_bypass', 'on', true);

-- Clean up any inconsistent cross-tenant or dangling references before
-- tightening composite foreign keys.
UPDATE media_folders mf
   SET parent_id = NULL
 WHERE mf.parent_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM media_folders parent
      WHERE parent.id = mf.parent_id
        AND parent.business_id = mf.business_id
   );

UPDATE media_assets ma
   SET folder_id = NULL
 WHERE ma.folder_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM media_folders mf
      WHERE mf.id = ma.folder_id
        AND mf.business_id = ma.business_id
   );

UPDATE media_assets ma
   SET source_asset_id = NULL
 WHERE ma.source_asset_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM media_assets src
      WHERE src.id = ma.source_asset_id
        AND src.business_id = ma.business_id
   );

SELECT set_config('app.rls_bypass', '', true);

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_folders_business_id
  ON media_folders (business_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_assets_business_id
  ON media_assets (business_id, id);

ALTER TABLE media_folders
  DROP CONSTRAINT IF EXISTS media_folders_parent_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'media_folders_business_parent_id_fkey'
       AND conrelid = 'media_folders'::regclass
  ) THEN
    ALTER TABLE media_folders
      ADD CONSTRAINT media_folders_business_parent_id_fkey
      FOREIGN KEY (business_id, parent_id)
      REFERENCES media_folders (business_id, id)
      ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE media_assets
  DROP CONSTRAINT IF EXISTS media_assets_folder_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'media_assets_business_folder_id_fkey'
       AND conrelid = 'media_assets'::regclass
  ) THEN
    ALTER TABLE media_assets
      ADD CONSTRAINT media_assets_business_folder_id_fkey
      FOREIGN KEY (business_id, folder_id)
      REFERENCES media_folders (business_id, id)
      ON DELETE SET NULL (folder_id);
  END IF;
END $$;

ALTER TABLE media_assets
  DROP CONSTRAINT IF EXISTS media_assets_source_asset_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'media_assets_business_source_asset_id_fkey'
       AND conrelid = 'media_assets'::regclass
  ) THEN
    ALTER TABLE media_assets
      ADD CONSTRAINT media_assets_business_source_asset_id_fkey
      FOREIGN KEY (business_id, source_asset_id)
      REFERENCES media_assets (business_id, id)
      ON DELETE SET NULL (source_asset_id);
  END IF;
END $$;

-- ── Platform storage migration fallback & audit tables ──────────────────────
ALTER TABLE platform_media_config
  ADD COLUMN IF NOT EXISTS previous_endpoint text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS previous_region text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS previous_bucket text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS previous_access_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS previous_secret_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS previous_force_path_style boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS previous_key_prefix text NOT NULL DEFAULT 'media',
  ADD COLUMN IF NOT EXISTS migration_state text NOT NULL DEFAULT 'idle'
    CHECK (migration_state IN ('idle', 'migrating', 'completed', 'failed', 'rolled_back'));

CREATE TABLE IF NOT EXISTS platform_media_migrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_email     text NOT NULL DEFAULT '',
  action          text NOT NULL
                  CHECK (action IN (
                    'config_saved',
                    'location_change_blocked',
                    'migration_started',
                    'migration_verified',
                    'migration_completed',
                    'migration_failed',
                    'migration_rolled_back'
                  )),
  status          text NOT NULL DEFAULT 'completed'
                  CHECK (status IN ('running', 'verified', 'completed', 'failed', 'rolled_back', 'blocked')),
  source_summary  jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_summary  jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_assets    integer NOT NULL DEFAULT 0 CHECK (total_assets >= 0),
  copied_assets   integer NOT NULL DEFAULT 0 CHECK (copied_assets >= 0),
  verified_assets integer NOT NULL DEFAULT 0 CHECK (verified_assets >= 0),
  total_bytes     bigint NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  error_detail    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_platform_media_migrations_created
  ON platform_media_migrations (created_at DESC);

CREATE TABLE IF NOT EXISTS platform_media_orphan_scans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode             text NOT NULL
                   CHECK (mode IN ('scheduled_scan', 'manual_scan', 'manual_cleanup')),
  status           text NOT NULL
                   CHECK (status IN ('ok', 'alert', 'skipped', 'error')),
  scanned_objects  integer NOT NULL DEFAULT 0 CHECK (scanned_objects >= 0),
  db_keys_count    integer NOT NULL DEFAULT 0 CHECK (db_keys_count >= 0),
  orphan_count     integer NOT NULL DEFAULT 0 CHECK (orphan_count >= 0),
  orphan_bytes     bigint NOT NULL DEFAULT 0 CHECK (orphan_bytes >= 0),
  young_skipped    integer NOT NULL DEFAULT 0 CHECK (young_skipped >= 0),
  prefix_skipped   integer NOT NULL DEFAULT 0 CHECK (prefix_skipped >= 0),
  deleted_count    integer NOT NULL DEFAULT 0 CHECK (deleted_count >= 0),
  oldest_orphan_at timestamptz,
  sample_keys      jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor_email      text,
  backup_confirmed boolean NOT NULL DEFAULT false,
  error_detail     text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_media_orphan_scans_created
  ON platform_media_orphan_scans (created_at DESC);

-- ── Retail product media references (cover/variant + ordered gallery) ───────
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS image_media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_items_image_media_id
  ON items (image_media_id)
  WHERE image_media_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS item_media (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id        uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  sort_order     integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, media_asset_id)
);

CREATE INDEX IF NOT EXISTS idx_item_media_item_sort
  ON item_media (item_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_item_media_asset
  ON item_media (media_asset_id);

ALTER TABLE item_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_media FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON item_media;
CREATE POLICY tenant_isolation ON item_media FOR ALL
  USING (
    app_rls_bypass() OR EXISTS (
      SELECT 1 FROM items i
       WHERE i.id = item_media.item_id
         AND app_owns_location(i.location_id)
    )
  )
  WITH CHECK (
    app_rls_bypass() OR EXISTS (
      SELECT 1 FROM items i
       WHERE i.id = item_media.item_id
         AND app_owns_location(i.location_id)
    )
  );

-- ── Continuous master sync for media_assets (soft-delete/restore/purge)
--    and retail product media ─────────────────────────────────────────────────
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('media_assets', 'id', 'business',             ''),
      ('items',        'id', 'location',             'updated_at'),
      ('item_media',   'id', 'parent:items:item_id', '')
    ) AS v(table_name, pk, scope, excluded)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_sync_capture ON %I', t.table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_sync_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_sync_capture_row(%L, %L, %L)',
      t.table_name, t.pk, t.scope, t.excluded);
  END LOOP;
END $$;

SELECT set_config('app.rls_bypass', 'on', true);

INSERT INTO sync_row_clocks (business_id, table_name, row_id, location_id, row_hlc)
SELECT ma.business_id, 'media_assets', ma.id::text, NULL::uuid,
       '000000000000000.000000000000000.'
  FROM media_assets ma
UNION ALL
SELECT l.business_id, 'item_media', im.id::text, i.location_id,
       '000000000000000.000000000000000.'
  FROM item_media im
  JOIN items i ON i.id = im.item_id
  JOIN locations l ON l.id = i.location_id
ON CONFLICT (business_id, table_name, row_id) DO NOTHING;

SELECT set_config('app.rls_bypass', '', true);
