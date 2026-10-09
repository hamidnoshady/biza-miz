-- ============================================================================
-- 0213_automotive_crm_lead_preferences.sql — issue #839 §12: what a car buyer
-- is looking for, and which cars on the lot are being shown to them.
--
-- ## Why this is two tables and not a column on `crm_leads`
--
-- The CRM already has the lead, its source, its owner, its follow-up date
-- (`next_action_at`), its notes and its custom fields (0157). None of those can
-- answer the only question a dealership asks a lead list: *which cars on my lot
-- does this person actually want?* A budget is a number to filter and compare
-- against an asking price; "interested in a used SUV, 1398 or newer, up to 8
-- billion, trading in a Pride" is a *query*, and a text note is where queries go
-- to die. So:
--
--   1. `crm_lead_vehicle_preferences` — one row per lead (the lead id IS the
--      primary key, so a second row for one person is a constraint violation
--      rather than a bug the service could introduce). Make/model/trim
--      interest, new-or-used, a year range, a budget range, trade-in interest
--      and its own note, whether a test drive was asked for, and free text for
--      everything else. Every range is checked for order (`from <= to`), because
--      a range typed backwards silently matches nothing and would be blamed on
--      the lot.
--   2. `crm_lead_vehicle_links` — "this car was shown to this lead": one row per
--      (lead, vehicle) pair, carrying *why* it is linked (interest, a test
--      drive, an offer, or the customer's own car being valued for trade-in).
--      The pair is unique, so showing somebody the same car twice records one
--      fact rather than two.
--
-- Both are 1:N/1:1 extensions of the *existing* CRM and *existing* vehicle
-- tables. No second customer directory, no second lead table, no second stock
-- table: `parties` stays canonical for the person (a converted lead becomes a
-- party exactly as before) and `automotive_vehicle_attributes` stays canonical
-- for the car.
--
-- ## Rules this file follows
--
--   * Forward-only and additive: two CREATE TABLEs plus indexes; nothing
--     existing is altered.
--   * Every tenant-owned table is RLS-ENABLED **and** FORCED with the standard
--     `tenant_isolation` policy, exactly as `crm_leads` and 0212's tables are.
--   * Every delete is CASCADE from its parent: a lead that is deleted takes its
--     preferences with it, and a vehicle row that disappears removes the links
--     to it — neither is an independent fact.
--   * The upgrade path is untouched: an existing tenant gets two empty tables,
--     and a café never reads them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. What this lead is looking for
-- ---------------------------------------------------------------------------
CREATE TABLE crm_lead_vehicle_preferences (
    -- One row per lead — the lead id is the key, not a separate serial.
    lead_id              uuid PRIMARY KEY REFERENCES crm_leads(id) ON DELETE CASCADE,
    business_id          uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

    -- The car they want. All optional: a lead who says only "something
    -- automatic under a billion" is a real lead, and forcing a make would make
    -- the counter invent one.
    make                 text,
    model                text,
    trim                 text,
    -- Explicit, and 'any' is a real answer rather than a null standing in for
    -- one: the lot's new/used filter is the first thing a salesperson asks.
    condition            text NOT NULL DEFAULT 'any'
        CHECK (condition IN ('new', 'used', 'any')),
    -- A *market* model year, stored exactly as `automotive_vehicle_attributes`
    -- stores it (see 0212's `vehicle_year_calendar`): «مدل ۱۴۰۲» and «مدل ۲۰۲۳»
    -- are both correct, and converting either would invent precision. The
    -- calendar lives beside the range so the two years are read in one unit.
    vehicle_year_calendar text NOT NULL DEFAULT 'jalali'
        CHECK (vehicle_year_calendar IN ('jalali', 'gregorian')),
    model_year_from      integer,
    model_year_to        integer,

    -- Budget, Rial and whole, as a range: "up to" is `from` NULL, "at least"
    -- is `to` NULL.
    budget_from_rial     bigint CHECK (budget_from_rial IS NULL OR budget_from_rial >= 0),
    budget_to_rial       bigint CHECK (budget_to_rial IS NULL OR budget_to_rial >= 0),

    -- Trade-in: the customer's *own* car is part of the deal, so it is
    -- recorded as an interest with its own description and, where a price was
    -- discussed, the figure. The car itself, once it is a unit on the lot, is
    -- linked in `crm_lead_vehicle_links` with purpose 'trade_in'.
    trade_in             boolean NOT NULL DEFAULT false,
    trade_in_description text,

    -- §12's test drive. A timestamp rather than a boolean: "when did they ask"
    -- is the fact worth keeping, and a flag can always be read off it.
    test_drive_requested_at timestamptz,

    notes                text,
    created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    -- Ranges that are typed backwards match nothing and would be blamed on the
    -- lot rather than on the typo, so they are refused here.
    CONSTRAINT crm_lead_vehicle_preferences_year_order
        CHECK (model_year_from IS NULL OR model_year_to IS NULL OR model_year_from <= model_year_to),
    CONSTRAINT crm_lead_vehicle_preferences_budget_order
        CHECK (budget_from_rial IS NULL OR budget_to_rial IS NULL OR budget_from_rial <= budget_to_rial),
    -- A trade-in interest with nothing said about the car is not a record.
    CONSTRAINT crm_lead_vehicle_preferences_trade_in_described
        CHECK (NOT trade_in OR length(btrim(coalesce(trade_in_description, ''))) > 0)
);

CREATE INDEX idx_crm_lead_vehicle_preferences_interest
    ON crm_lead_vehicle_preferences (business_id, condition, make, model);

ALTER TABLE crm_lead_vehicle_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_lead_vehicle_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_lead_vehicle_preferences FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 2. Which cars this lead has been shown
-- ---------------------------------------------------------------------------
CREATE TABLE crm_lead_vehicle_links (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    lead_id     uuid NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
    -- The physical car, not the model: "shown this exact stock number" is the
    -- fact a salesperson repeats, and it is what a test drive is taken in.
    serial_id   uuid NOT NULL REFERENCES item_serials(id) ON DELETE CASCADE,
    purpose     text NOT NULL DEFAULT 'interest'
        CHECK (purpose IN ('interest', 'test_drive', 'offer', 'trade_in')),
    note        text,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- One row per pair: showing somebody the same car twice is one fact.
    CONSTRAINT crm_lead_vehicle_links_unique UNIQUE (lead_id, serial_id)
);

CREATE INDEX idx_crm_lead_vehicle_links_lead
    ON crm_lead_vehicle_links (business_id, lead_id, created_at DESC);
CREATE INDEX idx_crm_lead_vehicle_links_vehicle
    ON crm_lead_vehicle_links (business_id, serial_id);

ALTER TABLE crm_lead_vehicle_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_lead_vehicle_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_lead_vehicle_links FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
