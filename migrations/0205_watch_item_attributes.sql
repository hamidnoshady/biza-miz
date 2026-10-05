-- Issue #795 Phase 6 — structured watch attributes.
--
-- A watch model is more than a name + SKU: the reference number, movement,
-- case, water resistance and the rest are what staff search by, what the
-- customer asks about, and what a resale listing needs. They were living in
-- the free-text name (or nowhere). One optional 1:1 row per catalogue item
-- keeps the shared `items` table industry-agnostic.
--
-- (The brand deliberately stays on items.brand_id — the shared brand
-- registry that filters/reports/commissions already read; duplicating it
-- here as text would fork the truth.)

CREATE TABLE watch_item_attributes (
    item_id            uuid PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    reference_no       text,
    movement           text CHECK (movement IN ('automatic', 'quartz', 'manual', 'solar', 'kinetic', 'smart')),
    case_material      text,
    case_diameter_mm   numeric(5, 1) CHECK (case_diameter_mm > 0),
    water_resistance_m integer CHECK (water_resistance_m >= 0),
    dial_color         text,
    bracelet_material  text,
    gender             text CHECK (gender IN ('men', 'women', 'unisex')),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE watch_item_attributes ENABLE ROW LEVEL SECURITY;
ALTER TABLE watch_item_attributes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON watch_item_attributes FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = watch_item_attributes.item_id AND app_owns_location(i.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = watch_item_attributes.item_id AND app_owns_location(i.location_id)));

-- Phase 6 search: finding a unit by (partial) serial is a counter-top
-- operation; the only index so far served the per-item uniqueness check.
CREATE INDEX idx_item_serials_serial_number ON item_serials (serial_number text_pattern_ops);
