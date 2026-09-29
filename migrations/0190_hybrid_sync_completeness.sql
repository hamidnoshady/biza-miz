-- 0190_hybrid_sync_completeness.sql
-- Hybrid sync completeness: commit-ordered pull, push backoff, open-order
-- state convergence, and continuous master-data sync with per-field merge.
-- See docs/phases/Phase-44-Hybrid-Sync-Completeness.md.

-- ---------------------------------------------------------------------------
-- 1. sync_events: a commit-safe pull cursor and per-row push backoff
-- ---------------------------------------------------------------------------
-- `id` is allocated at INSERT, not at COMMIT, so a pull cursor over `id`
-- skips a row whose transaction commits after a higher id was already read.
-- `txid` is the writing transaction; a reader only hands out rows whose txid is
-- below pg_snapshot_xmin (every such transaction has finished), ordered by
-- (txid, id), so nothing that commits later can land behind the cursor.
ALTER TABLE sync_events
  ADD COLUMN IF NOT EXISTS txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  ADD COLUMN IF NOT EXISTS push_attempts integer NOT NULL DEFAULT 0 CHECK (push_attempts >= 0),
  ADD COLUMN IF NOT EXISTS next_push_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_sync_events_pull_txid
  ON sync_events (location_id, txid, id)
  WHERE origin = 'local' AND applied_at IS NOT NULL AND error IS NULL;

-- ---------------------------------------------------------------------------
-- 2. A hybrid logical clock per database
-- ---------------------------------------------------------------------------
-- Format: 15-digit milliseconds . 15-digit sequence . node id. Text-sortable,
-- so "which edit is newer" is a string comparison on every node. The sequence
-- keeps one node's stamps strictly increasing without a hot lock row, and the
-- floor is raised whenever a peer's clock is observed, so a node whose wall
-- clock lags never stamps an edit older than one it has already seen.
CREATE TABLE IF NOT EXISTS sync_hlc_state (
    singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    node_id    text    NOT NULL,
    floor_ms   bigint  NOT NULL DEFAULT 0
);
INSERT INTO sync_hlc_state (node_id)
SELECT substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
WHERE NOT EXISTS (SELECT 1 FROM sync_hlc_state);

CREATE SEQUENCE IF NOT EXISTS sync_hlc_seq;

CREATE OR REPLACE FUNCTION app_sync_node_id() RETURNS text
    LANGUAGE sql STABLE
    AS $$ SELECT node_id FROM sync_hlc_state $$;

CREATE OR REPLACE FUNCTION app_sync_next_hlc() RETURNS text
    LANGUAGE plpgsql VOLATILE
    AS $$
DECLARE
  now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  st sync_hlc_state;
BEGIN
  SELECT * INTO st FROM sync_hlc_state;
  RETURN lpad(greatest(now_ms, st.floor_ms)::text, 15, '0') || '.' ||
         lpad(nextval('sync_hlc_seq')::text, 15, '0') || '.' || st.node_id;
END $$;

CREATE OR REPLACE FUNCTION app_sync_observe_hlc(stamp text) RETURNS void
    LANGUAGE plpgsql VOLATILE
    AS $$
DECLARE
  ms bigint;
BEGIN
  IF stamp IS NULL OR stamp !~ '^[0-9]{15}\.' THEN RETURN; END IF;
  ms := split_part(stamp, '.', 1)::bigint;
  UPDATE sync_hlc_state SET floor_ms = ms WHERE floor_ms < ms;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Open-order state convergence
-- ---------------------------------------------------------------------------
-- The stamp of the last `order.state.synced` applied or emitted for this order.
-- A state older than it is ignored, so a late retry can never roll a bill back.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sync_state_hlc text;

-- ---------------------------------------------------------------------------
-- 4. Master data: per-field clocks, captured by trigger on every write path
-- ---------------------------------------------------------------------------
-- One row per synchronised master row. field_clocks maps each changed column
-- to the clock of its last local edit; a column absent from the map has never
-- been edited since this row was first tracked (the zero clock). The feed is
-- read by (txid, table_name, row_id) under the same snapshot-xmin rule as
-- sync_events, so an edit that commits late is never passed over.
CREATE TABLE IF NOT EXISTS sync_row_clocks (
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    table_name    text NOT NULL,
    row_id        text NOT NULL,
    -- NULL = business-wide (delivered to every branch); otherwise the branch
    -- the row belongs to, so a desktop only receives its own menu.
    location_id   uuid,
    field_clocks  jsonb NOT NULL DEFAULT '{}'::jsonb,
    row_hlc       text NOT NULL,
    deleted       boolean NOT NULL DEFAULT false,
    writer_node   text,
    txid          xid8 NOT NULL DEFAULT pg_current_xact_id(),
    PRIMARY KEY (business_id, table_name, row_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_row_clocks_feed
  ON sync_row_clocks (business_id, txid, table_name, row_id);

ALTER TABLE sync_row_clocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_row_clocks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_row_clocks FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- A master change that could not be merged (a unique-name clash between two
-- rows created independently on each side, a delete blocked by history the
-- other side does not know about). Recorded rather than retried forever, and
-- shown to the owner on the sync panel.
CREATE TABLE IF NOT EXISTS sync_master_conflicts (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    table_name   text NOT NULL,
    row_id       text NOT NULL,
    error_code   text NOT NULL,
    detail       text,
    incoming     jsonb NOT NULL DEFAULT '{}'::jsonb,
    attempts     integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
    status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, table_name, row_id, error_code)
);
ALTER TABLE sync_master_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_master_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_master_conflicts FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Trigger arguments (kept identical to MASTER_SYNC_TABLES in
-- src/lib/master-sync-registry.ts; an integration test compares them):
--   0: primary-key columns, comma separated
--   1: scope — 'business' | 'location' | 'parent:<table>:<fk column>'
--   2: columns never synchronised (derived locally), comma separated
-- Applying a peer's change sets app.sync_replay, so the trigger records nothing
-- and the merge code writes the peer's clocks itself — that is what stops an
-- edit bouncing between the two sides.
CREATE OR REPLACE FUNCTION app_sync_capture_row() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  pk_cols   text[] := string_to_array(TG_ARGV[0], ',');
  scope     text   := TG_ARGV[1];
  excluded  text[] := CASE WHEN TG_NARGS > 2 AND TG_ARGV[2] <> '' THEN string_to_array(TG_ARGV[2], ',') ELSE '{}'::text[] END;
  rec       jsonb;
  old_rec   jsonb;
  changed   text[];
  row_key   text;
  biz       uuid;
  loc       uuid;
  stamp     text;
  parts     text[];
BEGIN
  IF coalesce(current_setting('app.sync_replay', true), '') = 'on' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    rec := to_jsonb(OLD);
  ELSE
    rec := to_jsonb(NEW);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_rec := to_jsonb(OLD);
    SELECT array_agg(n.key) INTO changed
      FROM jsonb_each(rec) n
     WHERE n.value IS DISTINCT FROM old_rec -> n.key
       AND NOT (n.key = ANY (excluded));
    IF changed IS NULL THEN
      RETURN NULL;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT array_agg(n.key) INTO changed
      FROM jsonb_each(rec) n
     WHERE NOT (n.key = ANY (excluded));
  END IF;

  SELECT string_agg(rec ->> c, '|' ORDER BY ord) INTO row_key
    FROM unnest(pk_cols) WITH ORDINALITY AS u(c, ord);

  IF scope = 'business' THEN
    biz := (rec ->> 'business_id')::uuid;
    loc := NULL;
  ELSIF scope = 'location' THEN
    loc := (rec ->> 'location_id')::uuid;
    SELECT l.business_id INTO biz FROM locations l WHERE l.id = loc;
  ELSE
    parts := string_to_array(scope, ':');
    EXECUTE format('SELECT location_id FROM %I WHERE id = $1', parts[2])
       INTO loc USING (rec ->> parts[3])::uuid;
    -- The parent is gone: this row went with it by cascade, and the parent's
    -- own tombstone already carries the delete.
    IF loc IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT l.business_id INTO biz FROM locations l WHERE l.id = loc;
  END IF;
  IF biz IS NULL OR row_key IS NULL THEN
    RETURN NULL;
  END IF;
  -- The business itself is being deleted and this row is going with it by
  -- cascade: there is no peer left to tell, and a tombstone would reference a
  -- business that no longer exists.
  IF NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = biz) THEN
    RETURN NULL;
  END IF;

  stamp := app_sync_next_hlc();
  IF TG_OP = 'DELETE' THEN
    INSERT INTO sync_row_clocks (business_id, table_name, row_id, location_id, field_clocks, row_hlc, deleted, writer_node, txid)
    VALUES (biz, TG_TABLE_NAME, row_key, loc, '{}'::jsonb, stamp, true, app_sync_node_id(), pg_current_xact_id())
    ON CONFLICT (business_id, table_name, row_id) DO UPDATE
       SET deleted = true, row_hlc = EXCLUDED.row_hlc, writer_node = EXCLUDED.writer_node,
           txid = EXCLUDED.txid, location_id = EXCLUDED.location_id;
  ELSE
    INSERT INTO sync_row_clocks (business_id, table_name, row_id, location_id, field_clocks, row_hlc, deleted, writer_node, txid)
    VALUES (biz, TG_TABLE_NAME, row_key, loc,
            (SELECT jsonb_object_agg(c, stamp) FROM unnest(changed) c),
            stamp, false, app_sync_node_id(), pg_current_xact_id())
    ON CONFLICT (business_id, table_name, row_id) DO UPDATE
       SET field_clocks = sync_row_clocks.field_clocks || EXCLUDED.field_clocks,
           row_hlc = EXCLUDED.row_hlc, deleted = false, writer_node = EXCLUDED.writer_node,
           txid = EXCLUDED.txid, location_id = EXCLUDED.location_id;
  END IF;
  -- Wakes a desktop's sync runner on commit (the same channel the outbox
  -- uses); nobody listens on a central server, where it costs nothing.
  PERFORM pg_notify('sync_outbox', '');
  RETURN NULL;
END $$;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('party_categories',          'id',                              'business',                      'updated_at'),
      ('parties',                   'id',                              'business',                      'updated_at,rfm_recency,rfm_frequency,rfm_monetary,rfm_scored_at,last_interaction_at,last_source,phone_enc,phone_bidx,phone_e164,phone_last4,phone_kind,address_enc,notes_enc,national_id_enc,national_id_bidx,economic_code_enc,profile_image_asset_id'),
      ('payment_methods',           'id',                              'business',                      ''),
      ('menu_categories',           'id',                              'location',                      ''),
      ('modifier_groups',           'id',                              'location',                      ''),
      ('modifiers',                 'id',                              'location',                      ''),
      ('inventory_items',           'id',                              'location',                      'avg_cost,carrying_value_rial,image_media_id'),
      ('menu_items',                'id',                              'location',                      'updated_at,image_media_id'),
      ('dining_tables',             'id',                              'location',                      'status,section_id'),
      ('menu_item_modifier_groups', 'menu_item_id,modifier_group_id',  'parent:menu_items:menu_item_id', ''),
      ('menu_item_ingredients',     'menu_item_id,inventory_item_id',  'parent:menu_items:menu_item_id', ''),
      ('modifier_ingredients',      'modifier_id,inventory_item_id',   'parent:modifiers:modifier_id',   '')
    ) AS v(table_name, pk, scope, excluded)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_sync_capture ON %I', t.table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_sync_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_sync_capture_row(%L, %L, %L)',
      t.table_name, t.pk, t.scope, t.excluded);
  END LOOP;
END $$;

-- Backfill: every existing master row is tracked at the zero clock, so a
-- desktop paired from now on receives the business's current customers and
-- menu through the same feed, while two sides that already hold the same row
-- compare equal and change nothing. Transaction-local bypass: this spans every
-- business, and the runner wraps each file in its own transaction.
SELECT set_config('app.rls_bypass', 'on', true);

INSERT INTO sync_row_clocks (business_id, table_name, row_id, location_id, row_hlc)
SELECT business_id, 'party_categories', id::text, NULL::uuid, '000000000000000.000000000000000.' FROM party_categories
UNION ALL
SELECT business_id, 'parties', id::text, NULL, '000000000000000.000000000000000.' FROM parties
UNION ALL
SELECT business_id, 'payment_methods', id::text, NULL, '000000000000000.000000000000000.' FROM payment_methods
UNION ALL
SELECT l.business_id, 'menu_categories', t.id::text, t.location_id, '000000000000000.000000000000000.'
  FROM menu_categories t JOIN locations l ON l.id = t.location_id
UNION ALL
SELECT l.business_id, 'modifier_groups', t.id::text, t.location_id, '000000000000000.000000000000000.'
  FROM modifier_groups t JOIN locations l ON l.id = t.location_id
UNION ALL
SELECT l.business_id, 'modifiers', t.id::text, t.location_id, '000000000000000.000000000000000.'
  FROM modifiers t JOIN locations l ON l.id = t.location_id
UNION ALL
SELECT l.business_id, 'inventory_items', t.id::text, t.location_id, '000000000000000.000000000000000.'
  FROM inventory_items t JOIN locations l ON l.id = t.location_id
UNION ALL
SELECT l.business_id, 'menu_items', t.id::text, t.location_id, '000000000000000.000000000000000.'
  FROM menu_items t JOIN locations l ON l.id = t.location_id
UNION ALL
SELECT l.business_id, 'dining_tables', t.id::text, t.location_id, '000000000000000.000000000000000.'
  FROM dining_tables t JOIN locations l ON l.id = t.location_id
UNION ALL
SELECT l.business_id, 'menu_item_modifier_groups', t.menu_item_id::text || '|' || t.modifier_group_id::text, p.location_id,
       '000000000000000.000000000000000.'
  FROM menu_item_modifier_groups t JOIN menu_items p ON p.id = t.menu_item_id JOIN locations l ON l.id = p.location_id
UNION ALL
SELECT l.business_id, 'menu_item_ingredients', t.menu_item_id::text || '|' || t.inventory_item_id::text, p.location_id,
       '000000000000000.000000000000000.'
  FROM menu_item_ingredients t JOIN menu_items p ON p.id = t.menu_item_id JOIN locations l ON l.id = p.location_id
UNION ALL
SELECT l.business_id, 'modifier_ingredients', t.modifier_id::text || '|' || t.inventory_item_id::text, p.location_id,
       '000000000000000.000000000000000.'
  FROM modifier_ingredients t JOIN modifiers p ON p.id = t.modifier_id JOIN locations l ON l.id = p.location_id
ON CONFLICT (business_id, table_name, row_id) DO NOTHING;

SELECT set_config('app.rls_bypass', '', true);
