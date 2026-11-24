-- 0318_order_number_lease.sql — one authority for a location's order numbers.
--
-- ## The defect this closes
--
-- `order_number_counters` is per database, not per location-across-the-fleet.
-- A paired till and the cloud therefore advanced two independent counters, and
-- a pulled order whose number was already taken on the receiving side was
-- silently renumbered ("take this side's next"), so a bill rung up as #820 was
-- stored in the cloud as #821. A receipt, a dead letter and a report then
-- disagreed about which document a sale was.
--
-- ## The allocation scheme
--
-- `order_number_sequence` is the cloud's counter for one location. Nothing
-- else hands out numbers: every cloud-created bill (POS, website/CMS,
-- WooCommerce, imported sale, retail invoice) draws one from it, and a paired
-- till leases a BLOCK of it (`order_number_lease`) and mints inside that block
-- locally. The sequence only ever moves forward, so a leased block is never
-- given to a second device, which is what lets the receiving side store a
-- pulled order under the number its receipt already shows.
--
-- `order_number_lease.next_number` is the local cursor (the next number the
-- block may hand out) and `consumed_at` marks the block used up. On the cloud
-- the row is the record of the grant; on the till it is also the offline
-- allocator.
--
-- ## Upgrade behaviour
--
-- Every existing location is seeded from BOTH the old counter and its highest
-- order number, so an install continues exactly where it was. A Local install
-- keeps using the sequence directly (it has no peer); a Hybrid till starts
-- leasing on its first tick after this migration and no longer writes its own
-- counter. `order_number_counters` is deliberately left in place: an older
-- desktop build is still running during rollout and its own database still
-- uses that table. Forward-only; to withdraw, drop `order_number_lease` and
-- `order_number_sequence` — the orders themselves keep their numbers.

-- ---------------------------------------------------------------------------
-- 1. The cloud-owned sequence, one row per location
-- ---------------------------------------------------------------------------
CREATE TABLE order_number_sequence (
    location_id uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
    next_number bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Continue where the location actually is: the old counter may be behind a
-- number inserted by another path (an import, a test fixture, a manual
-- repair), so the higher of the two wins. Without this the first cloud-created
-- order after the migration would collide with the last one before it.
--
-- The read spans every business, so the FORCE-RLS policies on `orders` and
-- `order_number_counters` are stood down for this transaction only — the same
-- escape the migration runner has no tenant to derive. It is transaction-local
-- (`true`) and does not outlive the migration.
SELECT set_config('app.rls_bypass', 'on', true);

INSERT INTO order_number_sequence (location_id, next_number)
SELECT l.id,
       greatest(
         coalesce(c.next_number, 1),
         coalesce((SELECT max(o.order_number) FROM orders o WHERE o.location_id = l.id), 0) + 1,
         1
       )
  FROM locations l
  LEFT JOIN order_number_counters c ON c.location_id = l.id
ON CONFLICT (location_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The blocks a paired till reserved
-- ---------------------------------------------------------------------------
CREATE TABLE order_number_lease (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    site_device_id uuid NOT NULL REFERENCES site_devices(id) ON DELETE CASCADE,
    from_number    bigint NOT NULL CHECK (from_number >= 1),
    to_number      bigint NOT NULL,
    -- The next number this block may hand out. It starts at from_number and
    -- reaches to_number + 1 exactly when the block is used up.
    next_number    bigint NOT NULL,
    leased_at      timestamptz NOT NULL DEFAULT now(),
    consumed_at    timestamptz,
    CONSTRAINT order_number_lease_range_check CHECK (to_number >= from_number),
    CONSTRAINT order_number_lease_cursor_check CHECK (next_number BETWEEN from_number AND to_number + 1),
    CONSTRAINT order_number_lease_consumed_check CHECK (consumed_at IS NULL OR next_number = to_number + 1)
);

-- A block starts once and belongs to one device. Two grants can never share a
-- first number, even if two cloud requests race for the same sequence row.
CREATE UNIQUE INDEX uq_order_number_lease_location_from
    ON order_number_lease (location_id, from_number);
CREATE INDEX idx_order_number_lease_active
    ON order_number_lease (location_id, site_device_id, from_number)
    WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Tenant isolation
-- ---------------------------------------------------------------------------
-- Both tables are branch data (a location's numbering), so they follow the
-- standard location-scoped policy from migration 0021 rather than a new shape.
ALTER TABLE order_number_sequence ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_number_sequence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_number_sequence FOR ALL
    USING (app_rls_bypass() OR location_id IN (
        SELECT l.id FROM locations l WHERE l.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR location_id IN (
        SELECT l.id FROM locations l WHERE l.business_id = app_current_business()));

ALTER TABLE order_number_lease ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_number_lease FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_number_lease FOR ALL
    USING (app_rls_bypass() OR location_id IN (
        SELECT l.id FROM locations l WHERE l.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR location_id IN (
        SELECT l.id FROM locations l WHERE l.business_id = app_current_business()));
