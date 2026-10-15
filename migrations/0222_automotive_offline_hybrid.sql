-- ============================================================================
-- 0222_automotive_offline_hybrid.sql — issue #839 §19, the Wave 6 hardening:
-- what a *paired* dealership desktop may read locally, and what it may only ask
-- the cloud to do.
--
-- ## Why this is two tables and not a synchronisation engine
--
-- The repo already has exactly one way for a site to hold cloud data and one
-- way for a site to send work up: the site-profile projection
-- (`GET /api/server-sync/site-profile`, Phase 45) and the `sync_events` outbox
-- (`appendSyncOutboxEvent`, acknowledged on the cloud by `applySyncEvent`).
-- Vehicle stock uses both — no second transport, no second queue, no
-- `item_serials` replication:
--
--   1. `automotive_vehicle_stock_mirror` — the branch's vehicle board, as the
--      cloud last stated it. It is **read-only by construction**: nothing in
--      this application writes it except the snapshot applier
--      (`automotive-stock-service.ts`), and the payload it is filled from
--      deliberately carries no acquisition cost, no capitalized costs and no
--      minimum price, so a cashier's laptop cannot leak a margin and no offline
--      path can post a ledger effect from mirrored data. VIN, chassis and stock
--      number are unique per business *here too* (partial unique indexes,
--      `upper(...)`, mirroring 0212), so a bad payload can never create the
--      ambiguous stock the issue forbids — the mirror refuses it whole instead.
--   2. `automotive_vehicle_offline_requests` — the durable queue of the only
--      two operations a site may take offline: **hold this car for a customer**
--      and **release a hold this branch placed**. Each row is an *intent* with
--      an idempotency key (its own id), the vehicle version the operator was
--      looking at (`expected_version`) and the state they saw
--      (`expected_state`); the cloud applies it through the canonical
--      `reserveVehicle` / `releaseVehicleReservation` inside one transaction,
--      or refuses it with a named conflict code the UI resolves. A pending row
--      is never shown as a hold, and a deposit on it is not a liability until
--      the cloud confirms it.
--
-- Two deliberate non-goals, recorded here so a later reader does not add them
-- by reflex:
--
--   * **No offline sale.** A sale moves revenue, COGS and tax; there is no
--     version of that which is safe to invent on a disconnected laptop and
--     reconcile afterwards. `offlineSaleFinalization` is `false` in the type
--     system (`automotive-offline.ts`), not merely unhandled.
--   * **No last-write-wins on a car.** The mirror is replaced whole from a
--     cloud snapshot and the hold is decided by the cloud's row lock plus
--     `serial_reservations`'s one-active-hold-per-serial index. Neither table
--     carries the master-data capture trigger (migration 0190), and
--     `integration/automotive-sync-classification.integration.test.ts` plus
--     `automotive-sync-classification.ts` keep it that way on purpose.
--
-- ## Rules this file follows
--
--   * Forward-only and additive: two new tables, their indexes, their RLS.
--     Nothing existing is altered, so an upgrading tenant of any industry sees
--     two empty tables it never reads.
--   * Every tenant-owned table is RLS-ENABLED **and** FORCED with the standard
--     `tenant_isolation` policy (both carry `business_id`).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The read-only branch mirror of the cloud's vehicle stock
-- ---------------------------------------------------------------------------
CREATE TABLE automotive_vehicle_stock_mirror (
    business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The branch the car sits on *in the cloud's answer*. A row whose branch is
    -- not this site's is not delivered at all (the projection is per branch).
    location_id            uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    -- No FK to item_serials: serials are deliberately not replicated, so on a
    -- site the row the mirror describes may legitimately be absent locally.
    -- The mirror is a projection of the cloud's row, not a second copy of it.
    serial_id              uuid NOT NULL,
    item_id                uuid,
    stock_number           text NOT NULL CHECK (length(btrim(stock_number)) > 0),
    make                   text NOT NULL CHECK (length(btrim(make)) > 0),
    model                  text NOT NULL CHECK (length(btrim(model)) > 0),
    trim                   text,
    condition              text NOT NULL CHECK (condition IN ('new', 'used')),
    state                  text NOT NULL CHECK (state IN (
                               'draft', 'acquired', 'in_stock', 'reserved',
                               'sold', 'returned', 'transferred', 'archived')),
    vehicle_year_calendar  text NOT NULL DEFAULT 'jalali'
        CHECK (vehicle_year_calendar IN ('jalali', 'gregorian')),
    model_year             integer,
    mileage_km             integer CHECK (mileage_km IS NULL OR mileage_km >= 0),
    vin                    text,
    chassis_number         text,
    plate_number           text,
    body_type              text,
    transmission           text,
    fuel_type              text,
    exterior_color         text,
    -- Days-in-stock offline needs the acquisition date; the *amounts* stay in
    -- the cloud (see the header).
    acquired_on            date,
    asking_price_rial      bigint CHECK (asking_price_rial IS NULL OR asking_price_rial >= 0),
    availability           text NOT NULL CHECK (availability IN ('available', 'reserved', 'sold', 'unavailable')),
    reservation_id         uuid,
    reservation_customer_name text,
    reservation_expires_at timestamptz,
    -- `updated_at` of the cloud row as epoch milliseconds: the version this row
    -- was built from, which is what a queued request quotes as `expected_version`.
    source_version         bigint NOT NULL CHECK (source_version > 0),
    cloud_updated_at       timestamptz NOT NULL,
    synced_at              timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, serial_id)
);

-- The local half of "duplicate VIN/chassis cannot create ambiguous stock": the
-- applier validates the payload before writing, and these indexes make the
-- guarantee structural even if a future writer forgets to.
CREATE UNIQUE INDEX uq_automotive_mirror_vin
    ON automotive_vehicle_stock_mirror (business_id, upper(vin)) WHERE vin IS NOT NULL;
CREATE UNIQUE INDEX uq_automotive_mirror_chassis
    ON automotive_vehicle_stock_mirror (business_id, upper(chassis_number)) WHERE chassis_number IS NOT NULL;
CREATE UNIQUE INDEX uq_automotive_mirror_stock_number
    ON automotive_vehicle_stock_mirror (business_id, upper(stock_number));
CREATE INDEX idx_automotive_mirror_branch_state
    ON automotive_vehicle_stock_mirror (business_id, location_id, state);
CREATE INDEX idx_automotive_mirror_availability
    ON automotive_vehicle_stock_mirror (business_id, location_id, availability);

ALTER TABLE automotive_vehicle_stock_mirror ENABLE ROW LEVEL SECURITY;
ALTER TABLE automotive_vehicle_stock_mirror FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automotive_vehicle_stock_mirror FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 2. The durable queue of the two offline-capable vehicle operations
-- ---------------------------------------------------------------------------
CREATE TABLE automotive_vehicle_offline_requests (
    -- The idempotency key. It is also the `sync_events.client_event_id` of the
    -- event that carries the request up, so a retried flush and a duplicate push
    -- both collapse onto one row and one hold.
    id                     uuid NOT NULL,
    business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The branch that made the request. The cloud only applies a request for a
    -- vehicle that is actually in this branch (see the replay classifier).
    location_id            uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    request_type           text NOT NULL CHECK (request_type IN ('reserve', 'release')),
    serial_id              uuid NOT NULL,
    stock_number           text NOT NULL CHECK (length(btrim(stock_number)) > 0),
    customer_id            uuid,
    customer_name          text,
    -- On `reserve`: the hold the cloud created. On `release`: the hold being
    -- released. Nullable while pending.
    reservation_id         uuid,
    deposit_amount_rial    bigint NOT NULL DEFAULT 0 CHECK (deposit_amount_rial >= 0),
    -- Same enum and same exclusion as 0212: a deposit is money received, and
    -- nothing posts until the cloud confirms the request.
    deposit_method         payment_method CHECK (deposit_method IS NULL OR deposit_method <> 'credit'),
    deposit_refundable     boolean NOT NULL DEFAULT true,
    deposit_note           text,
    note                   text,
    expires_at             date,
    expires_at_time        time,
    -- A release needs a reason (the canonical service requires one), and says
    -- whether the deposit goes back.
    reason                 text,
    refund_deposit         boolean,
    -- What the operator was looking at when they queued this.
    expected_version       bigint NOT NULL CHECK (expected_version > 0),
    expected_state         text NOT NULL,
    status                 text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'conflict', 'cancelled')),
    conflict_code          text,
    -- The cloud's own answer, verbatim, for audit and for the UI's detail view.
    outcome                jsonb,
    requested_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    requested_at           timestamptz NOT NULL DEFAULT now(),
    -- When this site last saw the cloud's answer for it.
    synced_at              timestamptz,
    resolved_at            timestamptz,
    updated_at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, id),
    -- A deposit amount without a method is the contradiction 0212 already
    -- refuses on the hold itself.
    CONSTRAINT automotive_offline_request_deposit_shape
        CHECK (deposit_amount_rial = 0 OR deposit_method IS NOT NULL),
    -- A release without a hold to release, or without a reason, is not a
    -- command the cloud could apply.
    CONSTRAINT automotive_offline_release_shape
        CHECK (request_type <> 'release' OR (reservation_id IS NOT NULL AND reason IS NOT NULL))
);

-- One open request per car per operation, per business: a double-tapped button
-- (or a second clerk on the same car) queues one intent, not two competing
-- ones. Resolved rows are exempt, so the history is complete.
CREATE UNIQUE INDEX uq_automotive_offline_request_open
    ON automotive_vehicle_offline_requests (business_id, serial_id, request_type)
    WHERE status = 'pending';
CREATE INDEX idx_automotive_offline_request_branch_status
    ON automotive_vehicle_offline_requests (business_id, location_id, status);
CREATE INDEX idx_automotive_offline_request_serial
    ON automotive_vehicle_offline_requests (business_id, serial_id);

ALTER TABLE automotive_vehicle_offline_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE automotive_vehicle_offline_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automotive_vehicle_offline_requests FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
