-- GH #1567 Phase 6.3 — subcontracted production stages for fashion orders.
--
-- A workshop often sends one stage of an order (sewing, embroidery, washing,
-- pressing) to an outside subcontractor. This migration extends the 6B
-- production order (migration 0330) instead of adding a second production
-- engine, supplier registry, stock ledger or accounting engine:
--
--   * the subcontractor is a canonical branch supplier alias (`suppliers`,
--     which reads its identity from `parties`);
--   * materials sent to the subcontractor are issued into the order's WIP
--     through the same F1 WAC primitives as any issue (Dr 1310 / Cr trade
--     inventory) and come back through the same return path. The quantity
--     the subcontractor holds is tracked here as custody, so the business
--     always knows what fabric sits outside its own shelves;
--   * accepted work accrues the subcontractor's charge into WIP against the
--     canonical Accounts Payable control account (Dr 1310 / Cr 2100). The
--     payable is attributed to the supplier alias through the A/P source
--     registry (ap-attribution.ts), so it shows on the supplier statement and
--     aging and is settled by the ordinary A/P payment — no new settlement;
--   * a chargeback for work or material the subcontractor lost reverses value
--     out of WIP against the same payable (Dr 2100 / Cr 1310) and is recorded
--     on the order as `recovered_rial`.
--
-- Invariants encoded here (asserted by
-- integration/fashion-production-subcontract.integration.test.ts):
--   * accepted + scrapped + shortage never exceed what was sent; rework units
--     stay with the subcontractor and are counted, not double-counted;
--   * per custody line, returned + consumed + lost never exceed what was sent;
--   * the order's WIP formula includes recoveries, so the WIP subledger still
--     equals GL 1310 and closes at exactly zero;
--   * every subcontract mutation is one row in the order's append-only action
--     log (idempotency + audit), now carrying the subcontract id.

ALTER TABLE item_production_orders
    ADD COLUMN IF NOT EXISTS recovered_rial bigint NOT NULL DEFAULT 0 CHECK (recovered_rial >= 0);

-- Replace the unnamed "value out ≤ value in" check with a named one that
-- also counts recoveries. Located by definition so the migration does not
-- depend on Postgres' auto-generated constraint name.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'item_production_orders'::regclass
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%received_value_rial + returned_value_rial%written_off_rial%'
  LOOP
    EXECUTE format('ALTER TABLE item_production_orders DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE item_production_orders
    ADD CONSTRAINT item_production_orders_wip_out_le_in
    CHECK (received_value_rial + returned_value_rial + written_off_rial + recovered_rial
           <= material_cost_rial + conversion_cost_rial);

CREATE TABLE IF NOT EXISTS item_production_subcontracts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    order_id            uuid NOT NULL REFERENCES item_production_orders(id) ON DELETE RESTRICT,
    -- The canonical branch supplier alias (identity via suppliers.party_id).
    supplier_id         uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    stage_code          text NOT NULL CHECK (stage_code ~ '^[a-z][a-z0-9_]{0,29}$'),
    reference           text NOT NULL CHECK (length(reference) BETWEEN 1 AND 60),
    -- The agreed charge per accepted unit (Rial). Rejected, scrapped and
    -- missing units are not charged.
    rate_per_unit_rial  bigint NOT NULL CHECK (rate_per_unit_rial >= 0),
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'approved', 'disputed', 'closed', 'cancelled')),
    sent_quantity       numeric(24, 9) NOT NULL DEFAULT 0 CHECK (sent_quantity >= 0),
    accepted_quantity   numeric(24, 9) NOT NULL DEFAULT 0 CHECK (accepted_quantity >= 0),
    scrapped_quantity   numeric(24, 9) NOT NULL DEFAULT 0 CHECK (scrapped_quantity >= 0),
    shortage_quantity   numeric(24, 9) NOT NULL DEFAULT 0 CHECK (shortage_quantity >= 0),
    -- Units inspected, rejected and handed back to the subcontractor to redo
    -- (cumulative; they stay in sent − accepted − scrapped − shortage).
    rework_quantity     numeric(24, 9) NOT NULL DEFAULT 0 CHECK (rework_quantity >= 0),
    accrued_rial        bigint NOT NULL DEFAULT 0 CHECK (accrued_rial >= 0),
    chargeback_rial     bigint NOT NULL DEFAULT 0 CHECK (chargeback_rial >= 0),
    dispute_note        text NULL CHECK (dispute_note IS NULL OR length(dispute_note) <= 300),
    approved_by         uuid NULL,
    approved_at         timestamptz NULL,
    version             integer NOT NULL DEFAULT 1,
    created_by          uuid NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    closed_at           timestamptz NULL,
    UNIQUE (business_id, reference),
    CHECK (accepted_quantity + scrapped_quantity + shortage_quantity <= sent_quantity)
);
CREATE INDEX IF NOT EXISTS item_production_subcontracts_order_idx ON item_production_subcontracts (order_id, status);
CREATE INDEX IF NOT EXISTS item_production_subcontracts_supplier_idx ON item_production_subcontracts (supplier_id);

-- Material the subcontractor holds for one subcontract (quantities in the
-- material's own unit). Value stays in the order's WIP; this is custody.
CREATE TABLE IF NOT EXISTS item_production_subcontract_materials (
    subcontract_id     uuid NOT NULL REFERENCES item_production_subcontracts(id) ON DELETE RESTRICT,
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    material_item_id   uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    sent_quantity      numeric(24, 9) NOT NULL DEFAULT 0 CHECK (sent_quantity >= 0),
    returned_quantity  numeric(24, 9) NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
    consumed_quantity  numeric(24, 9) NOT NULL DEFAULT 0 CHECK (consumed_quantity >= 0),
    lost_quantity      numeric(24, 9) NOT NULL DEFAULT 0 CHECK (lost_quantity >= 0),
    PRIMARY KEY (subcontract_id, material_item_id),
    CHECK (returned_quantity + consumed_quantity + lost_quantity <= sent_quantity)
);

-- The order's action log carries the subcontract a step belongs to; the A/P
-- attribution reads the supplier through it. Adding a nullable column does
-- not touch existing rows, so the append-only trigger is not involved.
ALTER TABLE item_production_order_actions
    ADD COLUMN IF NOT EXISTS subcontract_id uuid NULL REFERENCES item_production_subcontracts(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS item_production_order_actions_subcontract_idx
    ON item_production_order_actions (subcontract_id) WHERE subcontract_id IS NOT NULL;

ALTER TABLE item_production_order_actions DROP CONSTRAINT IF EXISTS item_production_order_actions_action_check;
ALTER TABLE item_production_order_actions ADD CONSTRAINT item_production_order_actions_action_check
    CHECK (action IN ('create', 'release', 'issue', 'return', 'progress', 'scrap', 'rework',
                      'assign', 'cost', 'receive', 'complete', 'cancel',
                      'subcontract_create', 'subcontract_approve', 'subcontract_send', 'subcontract_receive',
                      'subcontract_return_materials', 'subcontract_dispute', 'subcontract_resolve',
                      'subcontract_close', 'subcontract_cancel'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['item_production_subcontracts', 'item_production_subcontract_materials'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL
                      USING (app_rls_bypass() OR business_id = app_current_business())
                      WITH CHECK (app_rls_bypass() OR business_id = app_current_business())', t);
  END LOOP;
END $$;
