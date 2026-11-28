-- GH #1567 C3 — one scannable code, one thing, per branch: enforced by the
-- database across tables, not only by a service-layer pre-check.
--
-- A branch has two kinds of scannable code: item barcodes (`item_barcodes`,
-- UNIQUE (location_id, code) since 0080) and size-pack barcodes
-- (`item_size_packs.barcode`, unique among packs since 0331). Each service
-- checked the *other* table before writing, but two concurrent requests — an
-- item barcode and a pack barcode with the same digits — could both pass the
-- check and both commit, leaving a scan that resolves to two things.
--
-- `location_scan_codes` is the single per-branch code registry. Rows are
-- maintained by triggers on the two owning tables (never written by
-- application code), and its PRIMARY KEY (location_id, code) is the
-- race-safe arbiter: the second writer fails with 23505, which both services
-- already turn into their readable "this barcode is taken" refusal.
--
-- Existing collisions (possible before this migration, only via that race or
-- direct SQL) are resolved without losing anything silently: the item barcode
-- — the product's real identity, used by sales history and labels — keeps the
-- code; the pack's barcode is cleared and the fact is recorded in
-- `scan_code_collisions` (code, both owners, pack name) so the size-pack
-- screen can tell the owner to assign the pack a new code. No item, stock,
-- sale or ledger row is touched.

CREATE TABLE IF NOT EXISTS location_scan_codes (
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    code        text NOT NULL,
    owner_kind  text NOT NULL CHECK (owner_kind IN ('item_barcode', 'size_pack')),
    owner_id    uuid NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (location_id, code),
    UNIQUE (owner_kind, owner_id)
);
CREATE INDEX IF NOT EXISTS location_scan_codes_business_idx ON location_scan_codes (business_id);

CREATE TABLE IF NOT EXISTS scan_code_collisions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    code         text NOT NULL,
    kept_kind    text NOT NULL CHECK (kept_kind IN ('item_barcode', 'size_pack')),
    kept_id      uuid NOT NULL,
    cleared_kind text NOT NULL CHECK (cleared_kind IN ('item_barcode', 'size_pack')),
    cleared_id   uuid NOT NULL,
    cleared_name text NULL,
    detected_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at  timestamptz NULL
);
CREATE INDEX IF NOT EXISTS scan_code_collisions_open_idx ON scan_code_collisions (cleared_kind, cleared_id) WHERE resolved_at IS NULL;

-- 1. Item barcodes are already unique per branch.
INSERT INTO location_scan_codes (business_id, location_id, code, owner_kind, owner_id)
SELECT l.business_id, b.location_id, b.code, 'item_barcode', b.id
  FROM item_barcodes b JOIN locations l ON l.id = b.location_id
ON CONFLICT DO NOTHING;

-- 2. Record, then clear, pack barcodes that collide with an item barcode.
INSERT INTO scan_code_collisions (business_id, location_id, code, kept_kind, kept_id, cleared_kind, cleared_id, cleared_name)
SELECT p.business_id, p.location_id, p.barcode, 'item_barcode', b.id, 'size_pack', p.id, p.name
  FROM item_size_packs p
  JOIN item_barcodes b ON b.location_id = p.location_id AND b.code = p.barcode
 WHERE p.barcode IS NOT NULL;

UPDATE item_size_packs p
   SET barcode = NULL, version = p.version + 1, updated_at = now()
  FROM scan_code_collisions c
 WHERE c.cleared_kind = 'size_pack' AND c.cleared_id = p.id AND c.resolved_at IS NULL AND p.barcode = c.code;

-- 3. The remaining pack barcodes (unique among packs since 0331).
INSERT INTO location_scan_codes (business_id, location_id, code, owner_kind, owner_id)
SELECT p.business_id, p.location_id, p.barcode, 'size_pack', p.id
  FROM item_size_packs p
 WHERE p.barcode IS NOT NULL
ON CONFLICT DO NOTHING;

-- 4. Triggers keep the registry in step with its two owners.
CREATE OR REPLACE FUNCTION location_scan_codes_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  kind text := TG_ARGV[0];
  old_code text;
  new_code text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_code := CASE WHEN kind = 'item_barcode' THEN to_jsonb(OLD)->>'code' ELSE to_jsonb(OLD)->>'barcode' END;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_code := CASE WHEN kind = 'item_barcode' THEN to_jsonb(NEW)->>'code' ELSE to_jsonb(NEW)->>'barcode' END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    DELETE FROM location_scan_codes WHERE owner_kind = kind AND owner_id = OLD.id;
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF new_code IS NOT DISTINCT FROM old_code AND NEW.location_id = OLD.location_id THEN
      RETURN NULL;
    END IF;
    DELETE FROM location_scan_codes WHERE owner_kind = kind AND owner_id = OLD.id;
  END IF;

  IF new_code IS NOT NULL THEN
    -- A plain INSERT: a code already held at this branch raises 23505 on
    -- location_scan_codes_pkey and aborts the owning write.
    INSERT INTO location_scan_codes (business_id, location_id, code, owner_kind, owner_id)
    SELECT l.business_id, NEW.location_id, new_code, kind, NEW.id FROM locations l WHERE l.id = NEW.location_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS item_barcodes_scan_code ON item_barcodes;
CREATE TRIGGER item_barcodes_scan_code
  AFTER INSERT OR UPDATE OF code, location_id OR DELETE ON item_barcodes
  FOR EACH ROW EXECUTE FUNCTION location_scan_codes_sync('item_barcode');

DROP TRIGGER IF EXISTS item_size_packs_scan_code ON item_size_packs;
CREATE TRIGGER item_size_packs_scan_code
  AFTER INSERT OR UPDATE OF barcode, location_id OR DELETE ON item_size_packs
  FOR EACH ROW EXECUTE FUNCTION location_scan_codes_sync('size_pack');

-- 5. Tenant isolation, same shape as every fashion table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['location_scan_codes', 'scan_code_collisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL
                      USING (app_rls_bypass() OR business_id = app_current_business())
                      WITH CHECK (app_rls_bypass() OR business_id = app_current_business())', t);
  END LOOP;
END $$;
