-- Issue #795 Phase 3 — manager-approved customer return / exchange workflow
-- for serialized (watch) units.
--
-- Retail invoice void deliberately refuses watch lines because `sold` is a
-- terminal serial state with no generic way back (see
-- retail-invoice-void-service.ts). The missing normal-workflow answer is a
-- DEDICATED, explicit lifecycle on the exact physical unit:
--
--   requested → received_for_inspection → dispositioned   (or → cancelled)
--
-- with an explicit disposition chosen by an approving manager. The original
-- sale (order, snapshot, warranty history) is never mutated — the reversal
-- posts mirror entries and the unit's next state is a new fact.

CREATE TABLE serial_returns (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    order_item_id   uuid NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
    serial_id       uuid NOT NULL REFERENCES item_serials(id) ON DELETE RESTRICT,
    customer_id     uuid REFERENCES parties(id) ON DELETE SET NULL,
    status          text NOT NULL DEFAULT 'requested'
                      CHECK (status IN ('requested', 'received_for_inspection', 'dispositioned', 'cancelled')),
    disposition     text CHECK (disposition IN
                      ('returned_sellable', 'returned_service_required', 'returned_damaged',
                       'supplier_claim', 'write_off', 'exchange')),
    reason          text NOT NULL,
    inspection_notes text,
    refund_method   text CHECK (refund_method IN ('cash', 'card', 'card_to_card', 'online', 'credit')),
    refund_amount_rial bigint CHECK (refund_amount_rial >= 0),
    -- Every reversal journal entry the disposition posted (revenue/VAT,
    -- conditional COGS, commission) — the audit trail back into the ledger.
    reversed_entry_ids uuid[],
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    received_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    received_at     timestamptz,
    dispositioned_at timestamptz,
    cancelled_at    timestamptz
);

-- One live (not-cancelled) return per sold invoice line: the same sale can
-- never be unwound twice. (The same PHYSICAL unit can legitimately return
-- again after a later resale — that is a different order_item.)
CREATE UNIQUE INDEX uq_serial_returns_live_line
    ON serial_returns (order_item_id) WHERE status <> 'cancelled';

CREATE INDEX idx_serial_returns_business ON serial_returns (business_id, status);
CREATE INDEX idx_serial_returns_serial ON serial_returns (serial_id);

ALTER TABLE serial_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE serial_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON serial_returns FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- A damaged / written-off disposition is a terminal state of the physical
-- unit: it never silently reappears on the shelf, and its row (provenance,
-- cost basis, history) is never deleted.
ALTER TABLE item_serials DROP CONSTRAINT item_serials_status_check;
ALTER TABLE item_serials ADD CONSTRAINT item_serials_status_check
  CHECK (status IN ('in_stock', 'reserved', 'sold', 'in_repair', 'supplier_returned', 'written_off'));
