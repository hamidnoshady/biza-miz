-- GH #1567 Phase 6C — virtual size packs for the fashion trade.
--
-- A size pack («بستهٔ سایزی», e.g. one dress in S×1, M×2, L×2, XL×1 sold to a
-- wholesale buyer as a unit) is a *definition*, never an item: it has no
-- item_stock row and no stock of its own. Its availability is derived from its
-- components' on-hand quantities, and selling it sells the components — the
-- invoice route expands a pack line into ordinary per-variant lines in the
-- same transaction, so stock relief, WAC COGS and revenue are the existing
-- per-variant postings and nothing is ever counted twice.
--
-- item_size_pack_sales is the snapshot that ties an invoice back to the pack
-- version it sold (components, multipliers, wholesale prices, the order lines
-- each component became), so a later price or composition change never
-- rewrites what was sold, and a retried sale replays exactly.

CREATE TABLE IF NOT EXISTS item_size_packs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    -- ASCII-digit-folded scannable code (src/lib/barcode.ts); unique per branch
    -- among packs, and checked against item_barcodes by the service.
    barcode     text NULL CHECK (barcode IS NULL OR length(barcode) BETWEEN 4 AND 64),
    is_active   boolean NOT NULL DEFAULT true,
    version     integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by  uuid NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS item_size_packs_name_uq ON item_size_packs (location_id, lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS item_size_packs_barcode_uq ON item_size_packs (location_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS item_size_pack_components (
    pack_id          uuid NOT NULL REFERENCES item_size_packs(id) ON DELETE CASCADE,
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    item_id          uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    position         integer NOT NULL CHECK (position >= 0),
    quantity         integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
    unit_price_rial  bigint NOT NULL CHECK (unit_price_rial >= 0),
    PRIMARY KEY (pack_id, item_id)
);

CREATE TABLE IF NOT EXISTS item_size_pack_sales (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    -- Index of the pack line in the submitted invoice (a cart may carry the
    -- same pack twice, e.g. at different quantities).
    line_index     integer NOT NULL CHECK (line_index >= 0),
    pack_id        uuid NOT NULL REFERENCES item_size_packs(id) ON DELETE RESTRICT,
    pack_version   integer NOT NULL,
    pack_name      text NOT NULL,
    pack_quantity  integer NOT NULL CHECK (pack_quantity > 0),
    total_rial     bigint NOT NULL CHECK (total_rial >= 0),
    -- [{itemId, name, quantityPerPack, quantity, unitPriceRial, orderItemId}]
    components     jsonb NOT NULL,
    -- sha256 of the submitted pack lines: a retry under the same request key
    -- must carry the same pack request, or it is a conflict.
    request_hash   text NOT NULL,
    created_by     uuid NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (order_id, line_index)
);
CREATE INDEX IF NOT EXISTS item_size_pack_sales_pack_idx ON item_size_pack_sales (pack_id, created_at);

-- A sale snapshot is evidence of what was sold: never edited or deleted.
CREATE OR REPLACE FUNCTION reject_item_size_pack_sale_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'item_size_pack_sales is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_item_size_pack_sales_immutable ON item_size_pack_sales;
CREATE TRIGGER trg_item_size_pack_sales_immutable
    BEFORE UPDATE OR DELETE ON item_size_pack_sales
    FOR EACH ROW EXECUTE FUNCTION reject_item_size_pack_sale_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['item_size_packs', 'item_size_pack_components', 'item_size_pack_sales'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL
                      USING (app_rls_bypass() OR business_id = app_current_business())
                      WITH CHECK (app_rls_bypass() OR business_id = app_current_business())', t);
  END LOOP;
END $$;
