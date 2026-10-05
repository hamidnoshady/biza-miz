-- Issue #795 item 18 — a pre-owned intake becomes a real provenance
-- document instead of two flags on the serial.
--
-- Before: «ثبت دست‌دوم» stored condition_grade + box_and_papers on
-- item_serials and nothing else — where the piece came from, from whom,
-- against which document, at what value, whether anyone verified
-- authenticity: all unrecorded.
--
-- Now every intake writes a serial_preowned_intakes row carrying the whole
-- acquisition story. The serial keeps its mirrored condition/box flags (the
-- unit board reads those), and the intake row is the auditable document
-- behind them.
--
-- Accounting: the acquisition's inventory/AP posting happens where the unit
-- enters stock — receiveItemPurchase, the single mutation path for new
-- serials. The intake row records the agreed purchase value as provenance
-- and deliberately posts nothing itself: a second posting here would
-- double-count the same acquisition.

CREATE TABLE serial_preowned_intakes (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id            uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    -- Provenance pin: the unit a document describes must keep existing.
    serial_id              uuid NOT NULL REFERENCES item_serials(id) ON DELETE RESTRICT,
    -- Where the piece came from.
    source                 text NOT NULL
                             CHECK (source IN ('customer_tradein', 'direct_purchase', 'consignment', 'other')),
    -- The person/dealer it came from, when known.
    party_id               uuid REFERENCES parties(id) ON DELETE RESTRICT,
    document_no            text,
    -- The agreed acquisition value (Rial, whole) — provenance for the value
    -- that posted when the unit was received into stock.
    purchase_value_rial    bigint NOT NULL DEFAULT 0 CHECK (purchase_value_rial >= 0),
    intake_date            date NOT NULL,
    condition_grade        text NOT NULL,
    box_and_papers         boolean NOT NULL DEFAULT false,
    authenticity_verified  boolean NOT NULL DEFAULT false,
    authenticity_notes     text,
    service_history        text,
    production_year        integer CHECK (production_year BETWEEN 1900 AND 2100),
    accessories            text,
    notes                  text,
    -- Photo/document references (array of URLs or storage keys).
    media                  jsonb NOT NULL DEFAULT '[]',
    created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at             timestamptz NOT NULL DEFAULT now()
);

-- A unit CAN legitimately be taken in more than once (sold, later bought
-- back) — the latest intake describes the current stint on the shelf.
CREATE INDEX idx_serial_preowned_intakes_serial ON serial_preowned_intakes (serial_id, created_at DESC);
CREATE INDEX idx_serial_preowned_intakes_business ON serial_preowned_intakes (business_id);

ALTER TABLE serial_preowned_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE serial_preowned_intakes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON serial_preowned_intakes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
