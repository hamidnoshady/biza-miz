-- Issue #795 Phase 2/item 20 — the reservation (hold) workflow for
-- serialized units. The `reserved` serial status existed since Wave 1 but
-- nothing could enter or leave it; this gives it the real lifecycle:
--
--   active → converted (the reserving customer bought the unit)
--          → released  (staff freed it, with the reason recorded)
--          → expired   (the hold lapsed; the next sale to anyone heals it)
--
-- A deposit, where one is taken, settles through the existing AR /
-- store-credit flows against the same customer — this table records the
-- hold itself, which has no accounting effect until the unit actually
-- sells (the invoice) or comes off hold (nothing moved).

CREATE TABLE serial_reservations (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    serial_id      uuid NOT NULL REFERENCES item_serials(id) ON DELETE RESTRICT,
    -- A hold is FOR somebody — an anonymous hold is just the unit sitting
    -- on the shelf.
    customer_id    uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    status         text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'converted', 'released', 'expired')),
    -- The business-local date the hold lapses; NULL = until released.
    expires_at     date,
    note           text,
    release_reason text,
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    closed_at      timestamptz
);

-- One live hold per physical unit.
CREATE UNIQUE INDEX uq_serial_reservations_active
    ON serial_reservations (serial_id) WHERE status = 'active';

CREATE INDEX idx_serial_reservations_business ON serial_reservations (business_id, status);

ALTER TABLE serial_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE serial_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON serial_reservations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
