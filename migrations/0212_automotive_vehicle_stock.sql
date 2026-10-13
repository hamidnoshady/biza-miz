-- ============================================================================
-- 0212_automotive_vehicle_stock.sql — issue #839 Wave 2/3, the vehicle stock,
-- cost and hold foundation.
--
-- ## What this migration adds, and what it refuses to duplicate
--
-- The issue's architecture rule is that a car is **not quantity-only stock**:
-- `items` is the make/model/trim catalogue entry, `item_serials` is one row per
-- physical car, and everything automotive-shaped hangs off that serial as a
-- 1:1 extension — exactly the shape migration 0205 gave watch models. Nothing
-- here is a second inventory engine, a second party directory, a second media
-- store or a second ledger:
--
--   1. `automotive_vehicle_attributes` — the physical vehicle: identity
--      (VIN/chassis/engine/plate/stock number), explicit `new | used`
--      condition with the used-car facts, the stock lifecycle state, the
--      acquisition story, pricing, and the frozen sale facts. One row per
--      `item_serials` row; the serial is the primary key, so a second row for
--      one car is not a bug the service could introduce — it is a constraint
--      violation.
--   2. `automotive_vehicle_costs` — money spent on *one* vehicle (repair,
--      paint, detailing, tyres, parts, inspection, registration, transport,
--      customs, advertising, preparation), each row carrying the explicit
--      `posting` decision §5 demands: `capitalized` (it becomes part of the
--      car's effective cost) or `period_expense` (it is this period's
--      reconditioning overhead). Costs are **voided, never edited** — that is
--      what makes the accounting decision auditable rather than re-writable.
--      The years (`model_year`/`production_year`) travel with
--      `vehicle_year_calendar`: a bare year is a market label («مدل ۱۴۰۲»,
--      «مدل ۲۰۲۳»), not an instant, so converting it would invent precision
--      that does not exist — see `VEHICLE_YEAR_CALENDARS` in
--      src/lib/automotive.ts, which owns the ranges the CHECKs mirror.
--   3. `automotive_vehicle_price_history` — §6's price history. There is no
--      generic history table for `items`, and the price of a car is the number
--      a customer argues about, so each change writes its own row with the
--      previous and new asking/minimum/wholesale/promotional figures.
--   4. `automotive_vehicle_transfers` — §11's branch transfer history, with
--      the vehicle itself carrying `transferred` as a state while it is in
--      transit (between lots it belongs to neither).
--   5. `serial_reservations` gains the deposit columns §7 asks for. The hold
--      table already exists (migration 0202, issue #795 item 20) and is
--      already generic — serial-keyed, tenant-scoped, one active hold per unit
--      via a partial unique index, and it deliberately posts nothing. A second
--      automotive-only hold table would duplicate exactly the semantics that
--      table was built to own, so this migration **extends** it instead:
--      deposit amount/method/refundability/reference, an optional expiry time
--      beside the expiry date, the sale that converted it, and the ledger
--      entry of the deposit's own posting (a liability, never revenue).
--
-- ## Rules this file follows
--
--   * Forward-only. Migrations already applied are never edited, so every
--     change here is additive (ALTER … ADD COLUMN / CREATE TABLE / CREATE
--     INDEX) and re-runnable in shape.
--   * Every tenant-owned table is RLS-ENABLED **and** FORCED with the standard
--     `tenant_isolation` policy. There is no exempt case: all four carry
--     `business_id`.
--   * Uniqueness is structural. VIN, chassis number, engine number and stock
--     number are unique per `business_id` through partial unique indexes
--     (`WHERE … IS NOT NULL`, because an unregistered car legitimately has no
--     plate and an older import may have no ISO VIN). Case-insensitivity is
--     part of the index (`upper(...)`), so `wc123` and `WC123` cannot both
--     become stock even when a write path forgets to normalise.
--   * "Sold once" is structural too: `sold_order_item_id` is unique, so two
--     invoices cannot both claim the same car even under concurrency; the
--     service's `FOR UPDATE` lock decides which one wins.
--   * The demo/upgrade path is untouched: an upgrading tenant gets four empty
--     tables, and an F&B tenant never reads them.
--   * Deployment mode is unchanged. None of these tables carries the
--     master-data capture trigger, so a hybrid site keeps syncing the
--     catalogue it already syncs (`items`, and therefore each car's catalogue
--     row) while the per-vehicle rows — identity, cost, state, holds — stay
--     cloud-authoritative, exactly as `item_serials` and the sales that move
--     them already do. That is the safe default the issue asks for: one side
--     decides a sale, so two branches cannot both believe they sold the same
--     car. The offline vehicle workflow itself (a branch that can register and
--     sell a car while the link is down, and the conflict rules that go with
--     it) is Wave 6 work and deliberately not claimed by this file.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The physical vehicle
-- ---------------------------------------------------------------------------
CREATE TABLE automotive_vehicle_attributes (
    -- One row per physical car. CASCADE (not 0202's RESTRICT) is the deliberate
    -- difference: a *reservation* is a promise about a car and must not lose its
    -- subject, while this row IS the car's own record — deleting the serial
    -- deletes the vehicle record with it, exactly as 0205 does for a watch.
    serial_id              uuid PRIMARY KEY REFERENCES item_serials(id) ON DELETE CASCADE,
    business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id            uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

    -- Identity (§3). Make and model are required — a car with no make is not a
    -- catalogue entry — while everything a used car may legitimately not have
    -- (VIN before 1981, engine number ground off, plate until registration) is
    -- nullable. `stock_number` is the dealership's own handle and is required:
    -- it is what the key board, the lot sheet and the salesman call the car.
    make                   text NOT NULL CHECK (length(btrim(make)) > 0),
    model                  text NOT NULL CHECK (length(btrim(model)) > 0),
    trim                   text,
    -- The years are stored *as the vehicle's own market states them*, with the
    -- calendar named beside them: «مدل ۱۴۰۲» for a domestically-sold car,
    -- «مدل ۲۰۲۳» for an import, both correct, and converting either would
    -- invent a precision a bare year does not have. See
    -- `VEHICLE_YEAR_CALENDARS` in src/lib/automotive.ts, which owns the ranges
    -- this CHECK mirrors. One calendar serves both years because a shop states
    -- them in the same words.
    vehicle_year_calendar  text NOT NULL DEFAULT 'jalali'
        CHECK (vehicle_year_calendar IN ('jalali', 'gregorian')),
    model_year             integer,
    production_year        integer,
    vin                    text,
    chassis_number         text,
    engine_number          text,
    plate_number           text,
    stock_number           text NOT NULL CHECK (length(btrim(stock_number)) > 0),
    body_type              text CHECK (body_type IS NULL OR body_type IN (
                               'sedan', 'hatchback', 'suv', 'crossover', 'coupe', 'convertible',
                               'pickup', 'van', 'minibus', 'truck', 'other')),
    transmission           text CHECK (transmission IS NULL OR transmission IN (
                               'manual', 'automatic', 'cvt', 'dual_clutch', 'single_speed', 'other')),
    fuel_type              text CHECK (fuel_type IS NULL OR fuel_type IN (
                               'petrol', 'diesel', 'hybrid', 'plug_in_hybrid', 'electric', 'cng', 'lpg', 'other')),
    engine_spec            text,
    drivetrain             text CHECK (drivetrain IS NULL OR drivetrain IN ('fwd', 'rwd', 'awd', '4wd', 'other')),
    exterior_color         text,
    interior_color         text,

    -- Condition (§3): explicit, never inferred, and the used-car facts are
    -- optional because «avoid forcing every optional used-car field to be
    -- required» is the issue's own wording. The two CHECKs below are the
    -- contradictions that are never legitimate: a *new* car with mileage or
    -- with prior owners is a used car whose condition checkbox is wrong, and
    -- silently accepting it is how the new-vs-used report lies.
    condition              text NOT NULL CHECK (condition IN ('new', 'used')),
    mileage_km             integer CHECK (mileage_km IS NULL OR mileage_km >= 0),
    prior_owners           integer CHECK (prior_owners IS NULL OR prior_owners >= 0),
    registration_date      date,
    inspection_notes       text,
    body_condition_notes   text,
    mechanical_notes       text,
    service_history        text,
    provenance_source      text CHECK (provenance_source IS NULL OR provenance_source IN (
                               'direct_purchase', 'supplier_purchase', 'dealer_purchase',
                               'customer_purchase', 'trade_in', 'import', 'opening_stock', 'other')),
    provenance_party_id    uuid REFERENCES parties(id) ON DELETE SET NULL,
    provenance_note        text,
    CONSTRAINT automotive_vehicle_new_has_no_mileage
        CHECK (condition <> 'new' OR coalesce(mileage_km, 0) = 0),
    CONSTRAINT automotive_vehicle_new_has_no_prior_owners
        CHECK (condition <> 'new' OR coalesce(prior_owners, 0) = 0),

    -- Lifecycle (§3). `transferred` means *in transit between branches*; a
    -- hold or a sale refuses from it because the car is on neither lot until
    -- the receiving branch accepts it.
    state                  text NOT NULL DEFAULT 'draft' CHECK (state IN (
                               'draft', 'acquired', 'in_stock', 'reserved',
                               'sold', 'returned', 'transferred', 'archived')),

    -- Acquisition (§4). The base purchase price lives here; the landed costs
    -- live in `automotive_vehicle_costs` as rows, because §4 wants each of
    -- them named, dated, tied to a vendor/document and given its own posting
    -- decision — which is a table, not six more columns that could never carry
    -- a receipt. Both the original purchase cost and the effective cost stay
    -- readable: the purchase price is this column, the effective cost is
    -- `purchase_cost_rial + Σ capitalized costs`, and `frozen_effective_cost_rial`
    -- below captures what it *was* on the day the car sold.
    acquisition_date       date,
    acquisition_source     text CHECK (acquisition_source IS NULL OR acquisition_source IN (
                               'direct_purchase', 'supplier_purchase', 'dealer_purchase',
                               'customer_purchase', 'trade_in', 'import', 'opening_stock', 'other')),
    acquisition_party_id   uuid REFERENCES parties(id) ON DELETE SET NULL,
    purchase_cost_rial     bigint NOT NULL DEFAULT 0 CHECK (purchase_cost_rial >= 0),

    -- Pricing (§6): independent of accounting cost, and never written by the
    -- cost paths. `minimum_price_rial` is the floor a sale needs an explicit
    -- override permission to cross; null means "no floor recorded", which is
    -- deliberately not the same as zero.
    asking_price_rial      bigint NOT NULL DEFAULT 0 CHECK (asking_price_rial >= 0),
    minimum_price_rial     bigint CHECK (minimum_price_rial IS NULL OR minimum_price_rial >= 0),
    wholesale_price_rial   bigint CHECK (wholesale_price_rial IS NULL OR wholesale_price_rial >= 0),
    promotional_price_rial bigint CHECK (promotional_price_rial IS NULL OR promotional_price_rial >= 0),
    price_changed_at       timestamptz,
    price_changed_by       uuid REFERENCES users(id) ON DELETE SET NULL,

    -- The frozen sale facts (§8). Written once, by the sale, in the same
    -- transaction that completes the invoice: the car becomes `sold`, the
    -- customer/date/price are preserved, and `frozen_effective_cost_rial` is
    -- the number COGS posts — so a later price or cost change can never rewrite
    -- what the books already recorded for this unit.
    sold_order_id          uuid REFERENCES orders(id) ON DELETE SET NULL,
    sold_order_item_id     uuid REFERENCES order_items(id) ON DELETE SET NULL,
    sold_customer_id       uuid REFERENCES parties(id) ON DELETE SET NULL,
    sold_on                date,
    sale_price_rial        bigint CHECK (sale_price_rial IS NULL OR sale_price_rial >= 0),
    frozen_effective_cost_rial bigint CHECK (frozen_effective_cost_rial IS NULL OR frozen_effective_cost_rial >= 0),
    sold_by                uuid REFERENCES users(id) ON DELETE SET NULL,

    created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT automotive_vehicle_production_year_not_after_model_year
        CHECK (production_year IS NULL OR model_year IS NULL OR production_year <= model_year),
    CONSTRAINT automotive_vehicle_model_year_in_calendar
        CHECK (model_year IS NULL OR
               (vehicle_year_calendar = 'jalali' AND model_year BETWEEN 1300 AND 1500) OR
               (vehicle_year_calendar = 'gregorian' AND model_year BETWEEN 1900 AND 2100)),
    CONSTRAINT automotive_vehicle_production_year_in_calendar
        CHECK (production_year IS NULL OR
               (vehicle_year_calendar = 'jalali' AND production_year BETWEEN 1300 AND 1500) OR
               (vehicle_year_calendar = 'gregorian' AND production_year BETWEEN 1900 AND 2100))
);

-- The identity uniqueness §3 requires, per business, case-insensitively, and
-- only where the identifier exists at all.
CREATE UNIQUE INDEX uq_automotive_vehicle_vin
    ON automotive_vehicle_attributes (business_id, upper(vin)) WHERE vin IS NOT NULL;
CREATE UNIQUE INDEX uq_automotive_vehicle_chassis
    ON automotive_vehicle_attributes (business_id, upper(chassis_number)) WHERE chassis_number IS NOT NULL;
CREATE UNIQUE INDEX uq_automotive_vehicle_engine
    ON automotive_vehicle_attributes (business_id, upper(engine_number)) WHERE engine_number IS NOT NULL;
CREATE UNIQUE INDEX uq_automotive_vehicle_stock_number
    ON automotive_vehicle_attributes (business_id, upper(stock_number));

-- "Sold once", structurally (§8): one sale line per physical car.
CREATE UNIQUE INDEX uq_automotive_vehicle_sold_order_item
    ON automotive_vehicle_attributes (sold_order_item_id) WHERE sold_order_item_id IS NOT NULL;

CREATE INDEX idx_automotive_vehicle_business_state
    ON automotive_vehicle_attributes (business_id, state);
CREATE INDEX idx_automotive_vehicle_business_location_state
    ON automotive_vehicle_attributes (business_id, location_id, state);
CREATE INDEX idx_automotive_vehicle_business_make_model
    ON automotive_vehicle_attributes (business_id, make, model);
CREATE INDEX idx_automotive_vehicle_plate
    ON automotive_vehicle_attributes (business_id, plate_number) WHERE plate_number IS NOT NULL;

ALTER TABLE automotive_vehicle_attributes ENABLE ROW LEVEL SECURITY;
ALTER TABLE automotive_vehicle_attributes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automotive_vehicle_attributes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 2. Money spent on one vehicle — and the explicit posting decision
-- ---------------------------------------------------------------------------
CREATE TABLE automotive_vehicle_costs (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id        uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    serial_id          uuid NOT NULL REFERENCES automotive_vehicle_attributes(serial_id) ON DELETE CASCADE,
    category           text NOT NULL CHECK (category IN (
                           'repair', 'paint_body', 'detailing', 'tires', 'parts', 'inspection',
                           'registration', 'transport', 'customs', 'advertising', 'preparation', 'other')),
    -- §5's decision, per row: capitalized (into the car's basis) or period
    -- expense (this period's reconditioning overhead). Never both, never
    -- neither, and never decided later by a report.
    posting            text NOT NULL CHECK (posting IN ('capitalized', 'period_expense')),
    amount_rial        bigint NOT NULL CHECK (amount_rial > 0),
    incurred_on        date NOT NULL,
    vendor_party_id    uuid REFERENCES parties(id) ON DELETE SET NULL,
    document_ref       text,
    notes              text,
    -- The ledger entry this cost posted, so the panel and the books agree.
    ledger_entry_id    uuid,
    -- Voided, never edited: the audit trail of a wrong reconditioning cost is
    -- the void row plus its replacement, not a mutated amount.
    status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
    void_reason        text,
    voided_at          timestamptz,
    voided_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT automotive_vehicle_cost_void_is_complete
        CHECK (status <> 'void' OR (voided_at IS NOT NULL AND voided_by IS NOT NULL))
);

CREATE INDEX idx_automotive_vehicle_costs_vehicle
    ON automotive_vehicle_costs (business_id, serial_id, status);
CREATE INDEX idx_automotive_vehicle_costs_period
    ON automotive_vehicle_costs (business_id, incurred_on) WHERE status = 'active';

ALTER TABLE automotive_vehicle_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE automotive_vehicle_costs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automotive_vehicle_costs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. Price history
-- ---------------------------------------------------------------------------
CREATE TABLE automotive_vehicle_price_history (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id              uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id              uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    serial_id                uuid NOT NULL REFERENCES automotive_vehicle_attributes(serial_id) ON DELETE CASCADE,
    previous_asking_price_rial bigint NOT NULL CHECK (previous_asking_price_rial >= 0),
    asking_price_rial        bigint NOT NULL CHECK (asking_price_rial >= 0),
    minimum_price_rial       bigint CHECK (minimum_price_rial IS NULL OR minimum_price_rial >= 0),
    wholesale_price_rial     bigint CHECK (wholesale_price_rial IS NULL OR wholesale_price_rial >= 0),
    promotional_price_rial   bigint CHECK (promotional_price_rial IS NULL OR promotional_price_rial >= 0),
    reason                   text,
    changed_by               uuid REFERENCES users(id) ON DELETE SET NULL,
    changed_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_automotive_vehicle_price_history_vehicle
    ON automotive_vehicle_price_history (business_id, serial_id, changed_at DESC);

ALTER TABLE automotive_vehicle_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE automotive_vehicle_price_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automotive_vehicle_price_history FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 4. Branch transfers (§11)
-- ---------------------------------------------------------------------------
-- A physically moving car has a history, not just a new `location_id`: who
-- sent it, who received it, when, why, and which domain event recorded it.
-- The vehicle's `state` is `transferred` while this row is `in_transit`, and
-- the receiving branch's accept flips both in one transaction. A *sold* car
-- cannot be transferred (the service refuses; the state machine has no edge
-- from `sold` to `transferred`), and a *reserved* one carries its hold across
-- unless the caller explicitly cancels it first — §11's "explicit policy".
CREATE TABLE automotive_vehicle_transfers (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    serial_id         uuid NOT NULL REFERENCES automotive_vehicle_attributes(serial_id) ON DELETE RESTRICT,
    from_location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    to_location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    status            text NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'completed', 'cancelled')),
    note              text,
    started_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    started_at        timestamptz NOT NULL DEFAULT now(),
    completed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    completed_at      timestamptz,
    cancelled_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at      timestamptz,
    cancel_reason     text,
    -- The `automotive.vehicle_transferred` domain event, kept so the audit
    -- trail and the transfer row can always be reconciled.
    domain_event_id   uuid,
    CONSTRAINT automotive_vehicle_transfer_endpoints_differ
        CHECK (from_location_id <> to_location_id),
    CONSTRAINT automotive_vehicle_transfer_cancelled_is_complete
        CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)),
    CONSTRAINT automotive_vehicle_transfer_completed_is_complete
        CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND completed_by IS NOT NULL))
);

-- One car is in transit to at most one place at a time.
CREATE UNIQUE INDEX uq_automotive_vehicle_transfer_open
    ON automotive_vehicle_transfers (serial_id) WHERE status = 'in_transit';
CREATE INDEX idx_automotive_vehicle_transfers_vehicle
    ON automotive_vehicle_transfers (business_id, serial_id, started_at DESC);
CREATE INDEX idx_automotive_vehicle_transfers_branch
    ON automotive_vehicle_transfers (business_id, to_location_id, status);

ALTER TABLE automotive_vehicle_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE automotive_vehicle_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automotive_vehicle_transfers FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 5. Holds gain the deposit §7 asks for (the hold table itself is 0202)
-- ---------------------------------------------------------------------------
-- A reservation deposit is **not revenue**: it is money the dealership holds
-- against a future sale, so it posts to the shared customer-advance liability
-- (`WELL_KNOWN_CODES.layawayDeposit`, 2430 «پیشدریافت از مشتری») and is
-- applied — never re-earned — when the sale completes. `credit` is
-- deliberately not an allowed deposit method: a deposit is money received.
ALTER TABLE serial_reservations
    ADD COLUMN IF NOT EXISTS deposit_amount_rial bigint NOT NULL DEFAULT 0
        CHECK (deposit_amount_rial >= 0),
    -- The repo's own `payment_method` enum (0001), because a deposit is taken
    -- the same way any other money is and the ledger map
    -- (`ledgerSettlementFor`) must read it identically. `credit` is excluded by
    -- the CHECK: a deposit is money *received*, so "on account" is a
    -- contradiction in terms.
    ADD COLUMN IF NOT EXISTS deposit_method payment_method
        CHECK (deposit_method IS NULL OR deposit_method <> 'credit'),
    ADD COLUMN IF NOT EXISTS deposit_refundable boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS deposit_payment_method_id uuid REFERENCES payment_methods(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS deposit_note text,
    -- The ledger entry of the deposit's own receipt (Debit cash/bank /
    -- Credit customer advances), and of its refund where one happened.
    ADD COLUMN IF NOT EXISTS deposit_ledger_entry_id uuid,
    ADD COLUMN IF NOT EXISTS deposit_refund_entry_id uuid,
    ADD COLUMN IF NOT EXISTS deposit_refunded_at timestamptz,
    -- A hold's expiry is a business *day* (`expires_at`, 0202) and, at the
    -- counter, a time of day ("تا ساعت ۱۸ امروز") — §7 asks for both.
    ADD COLUMN IF NOT EXISTS expires_at_time time,
    -- The completed sale that converted this hold, for audit.
    ADD COLUMN IF NOT EXISTS converted_order_id uuid REFERENCES orders(id) ON DELETE SET NULL;

-- A deposit row that names an amount must name how it was received; a zero
-- deposit is "no deposit", not a method-shaped question.
ALTER TABLE serial_reservations
    ADD CONSTRAINT serial_reservations_deposit_shape
        CHECK (deposit_amount_rial = 0 OR deposit_method IS NOT NULL);
