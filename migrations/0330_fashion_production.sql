-- GH #1567 Phase 6B — fashion production orders (cut → sew → finish → QC → pack).
--
-- Extends the production concepts of migration 0090 (a bill of materials,
-- materials issued into work in progress 1310, labour/overhead absorbed via
-- 5180, finished goods receipted out of WIP) onto the `items` stock model a
-- fashion business keeps its goods in. No new ledger: stock moves through
-- F1's moving-WAC primitives on `item_stock`, money through the posting
-- engine (rules in fashion-production-posting-rules.ts), and both against the
-- trade's own inventory account (1374).
--
-- Invariants encoded here (and asserted by
-- integration/fashion-production.integration.test.ts):
--   * an order's material lines are a snapshot of its BOM at creation, so a
--     later BOM edit never changes an order in flight;
--   * issued/returned quantities and values only grow, and a line can never
--     return more than it issued;
--   * per stage, completed + scrapped never exceeds what the order planned;
--     receipts never exceed planned − scrapped;
--   * every mutation is one row in an append-only action log keyed by an
--     idempotency key, so a retried request returns the first result instead
--     of moving stock twice.

-- Fashion charts were provisioned without the production pair; production
-- posts through them. Same names/types as the shared template (0090).
INSERT INTO accounts (business_id, code, name, type)
SELECT b.id, v.code, v.name, v.type::account_type
  FROM businesses b
 CROSS JOIN (VALUES
     ('1310', 'کالای در جریان ساخت', 'asset'),
     ('5180', 'هزینهٔ تبدیل جذب‌شده در تولید', 'expense')
 ) v(code, name, type)
 WHERE b.industry = 'fashion_apparel'
ON CONFLICT (business_id, code) DO NOTHING;

CREATE TABLE IF NOT EXISTS item_production_boms (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    output_item_id  uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    -- Default labour + overhead per finished unit (Rial); an order may log
    -- actual costs instead.
    conversion_cost_per_unit_rial bigint NOT NULL DEFAULT 0 CHECK (conversion_cost_per_unit_rial >= 0),
    is_active       boolean NOT NULL DEFAULT true,
    created_by      uuid NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, name)
);
CREATE INDEX IF NOT EXISTS item_production_boms_output_idx ON item_production_boms (output_item_id);

CREATE TABLE IF NOT EXISTS item_production_bom_lines (
    bom_id            uuid NOT NULL REFERENCES item_production_boms(id) ON DELETE CASCADE,
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    material_item_id  uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    -- In the material's own unit (metres of fabric, pieces of zip) per ONE
    -- finished unit.
    quantity_per_unit numeric(24, 9) NOT NULL CHECK (quantity_per_unit > 0),
    PRIMARY KEY (bom_id, material_item_id)
);

CREATE TABLE IF NOT EXISTS item_production_orders (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id      uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    bom_id           uuid NULL REFERENCES item_production_boms(id) ON DELETE RESTRICT,
    output_item_id   uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    reference        text NOT NULL CHECK (length(reference) BETWEEN 1 AND 60),
    planned_quantity numeric(24, 9) NOT NULL CHECK (planned_quantity > 0),
    received_quantity numeric(24, 9) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
    scrapped_quantity numeric(24, 9) NOT NULL DEFAULT 0 CHECK (scrapped_quantity >= 0),
    status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'released', 'in_progress', 'completed', 'cancelled')),
    due_date         date NULL,
    -- Running WIP subledger for this order (Rial); equals its 1310 balance.
    material_cost_rial   bigint NOT NULL DEFAULT 0 CHECK (material_cost_rial >= 0),
    conversion_cost_rial bigint NOT NULL DEFAULT 0 CHECK (conversion_cost_rial >= 0),
    received_value_rial  bigint NOT NULL DEFAULT 0 CHECK (received_value_rial >= 0),
    returned_value_rial  bigint NOT NULL DEFAULT 0 CHECK (returned_value_rial >= 0),
    written_off_rial     bigint NOT NULL DEFAULT 0 CHECK (written_off_rial >= 0),
    version          integer NOT NULL DEFAULT 1,
    created_by       uuid NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    closed_at        timestamptz NULL,
    UNIQUE (business_id, reference),
    CHECK (received_quantity + scrapped_quantity <= planned_quantity),
    CHECK (received_value_rial + returned_value_rial + written_off_rial
           <= material_cost_rial + conversion_cost_rial)
);
CREATE INDEX IF NOT EXISTS item_production_orders_location_idx ON item_production_orders (location_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS item_production_order_materials (
    order_id          uuid NOT NULL REFERENCES item_production_orders(id) ON DELETE RESTRICT,
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    material_item_id  uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quantity_per_unit numeric(24, 9) NOT NULL CHECK (quantity_per_unit > 0),
    required_quantity numeric(24, 9) NOT NULL CHECK (required_quantity > 0),
    issued_quantity   numeric(24, 9) NOT NULL DEFAULT 0 CHECK (issued_quantity >= 0),
    issued_value_rial bigint NOT NULL DEFAULT 0 CHECK (issued_value_rial >= 0),
    returned_quantity numeric(24, 9) NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
    returned_value_rial bigint NOT NULL DEFAULT 0 CHECK (returned_value_rial >= 0),
    PRIMARY KEY (order_id, material_item_id),
    CHECK (returned_quantity <= issued_quantity),
    CHECK (returned_value_rial <= issued_value_rial)
);
CREATE INDEX IF NOT EXISTS item_production_order_materials_item_idx ON item_production_order_materials (material_item_id);

CREATE TABLE IF NOT EXISTS item_production_order_stages (
    order_id           uuid NOT NULL REFERENCES item_production_orders(id) ON DELETE RESTRICT,
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    seq                smallint NOT NULL CHECK (seq BETWEEN 1 AND 12),
    code               text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,29}$'),
    label              text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
    assignee_user_id   uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    completed_quantity numeric(24, 9) NOT NULL DEFAULT 0 CHECK (completed_quantity >= 0),
    scrapped_quantity  numeric(24, 9) NOT NULL DEFAULT 0 CHECK (scrapped_quantity >= 0),
    rework_quantity    numeric(24, 9) NOT NULL DEFAULT 0 CHECK (rework_quantity >= 0),
    PRIMARY KEY (order_id, seq),
    UNIQUE (order_id, code)
);

-- Append-only: one row per accepted mutation (and the audit trail).
CREATE TABLE IF NOT EXISTS item_production_order_actions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    order_id        uuid NOT NULL REFERENCES item_production_orders(id) ON DELETE RESTRICT,
    action          text NOT NULL CHECK (action IN ('create', 'release', 'issue', 'return', 'progress', 'scrap', 'rework',
                                                    'assign', 'cost', 'receive', 'complete', 'cancel')),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
    actor_user_id   uuid NULL,
    detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
    amount_rial     bigint NULL,
    at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS item_production_order_actions_order_idx ON item_production_order_actions (order_id, at);

CREATE OR REPLACE FUNCTION reject_item_production_action_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'item_production_order_actions is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_item_production_actions_immutable ON item_production_order_actions;
CREATE TRIGGER trg_item_production_actions_immutable
    BEFORE UPDATE OR DELETE ON item_production_order_actions
    FOR EACH ROW EXECUTE FUNCTION reject_item_production_action_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['item_production_boms', 'item_production_bom_lines', 'item_production_orders',
                           'item_production_order_materials', 'item_production_order_stages',
                           'item_production_order_actions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL
                      USING (app_rls_bypass() OR business_id = app_current_business())
                      WITH CHECK (app_rls_bypass() OR business_id = app_current_business())', t);
  END LOOP;
END $$;
