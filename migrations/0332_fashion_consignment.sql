-- GH #1567 Phase 6D — fashion consignment (امانی) by contract.
--
-- Goods an owner (the consignor) leaves with a fashion shop to sell on their
-- behalf, counted per variant under a contract with terms. Separate from the
-- gold 1:1 per-piece model (0055): only the shared `consignors` owner table
-- and the shared accounts 2110/4700 are reused.
--
-- Accounting contract (src/lib/fashion-consignment.ts):
--   * receive: consigned on-hand only. NOT item_stock, NOT 1374, no GL —
--     consigned goods are never recognised as owned assets on receipt.
--   * sale: Dr tenders / Cr VAT / Cr 2110 owner share / Cr 4700 commission;
--     no COGS.
--   * customer return (restock only): on-hand back, plus a reclass
--     Dr 2110 / Dr 4700 / Cr 4400 next to the normal refund entry.
--   * void: the sale entry reversed exactly; on-hand back.
--   * return to owner: on-hand only. settlement: Dr 2110 / Cr cash|bank.
-- Owned and consigned stock of one variant never mix (trigger below), so F1's
-- valuation (1374 = Σ item_stock value) is untouched by consignment.

INSERT INTO accounts (business_id, code, name, type)
SELECT b.id, v.code, v.name, v.type::account_type
  FROM businesses b
 CROSS JOIN (VALUES
     ('2110', 'پرداختنی به امانت‌گذاران', 'liability'),
     ('4700', 'درآمد کارمزد فروش امانی', 'revenue')
 ) v(code, name, type)
 WHERE b.industry = 'fashion_apparel'
ON CONFLICT (business_id, code) DO NOTHING;

CREATE TABLE IF NOT EXISTS fashion_consignment_contracts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    consignor_id  uuid NOT NULL REFERENCES consignors(id) ON DELETE RESTRICT,
    reference     text NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 100),
    starts_on     date NOT NULL,
    expires_on    date NULL CHECK (expires_on IS NULL OR expires_on >= starts_on),
    notes         text NULL CHECK (notes IS NULL OR length(notes) <= 2000),
    -- Paid to the owner so far (Rial); the contract's outstanding payable is
    -- Σ lines.share_sold − Σ lines.share_returned − Σ lines.share_voided − settled.
    settled_rial  bigint NOT NULL DEFAULT 0 CHECK (settled_rial >= 0),
    closed_at     timestamptz NULL,
    closed_by     uuid NULL,
    version       integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by    uuid NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fashion_consignment_contracts_ref_uq
    ON fashion_consignment_contracts (location_id, lower(btrim(reference)));
CREATE INDEX IF NOT EXISTS fashion_consignment_contracts_consignor_idx
    ON fashion_consignment_contracts (consignor_id);

CREATE TABLE IF NOT EXISTS fashion_consignment_lines (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id            uuid NOT NULL REFERENCES fashion_consignment_contracts(id) ON DELETE RESTRICT,
    business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    item_id                uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    terms                  text NOT NULL CHECK (terms IN ('owner_price', 'commission')),
    owner_unit_price_rial  bigint NULL CHECK (owner_unit_price_rial IS NULL OR owner_unit_price_rial > 0),
    commission_bp          integer NULL CHECK (commission_bp IS NULL OR commission_bp BETWEEN 0 AND 10000),
    -- The shop's own shelf price for this consigned variant (falls back to item_stock.unit_price).
    retail_price_rial      bigint NULL CHECK (retail_price_rial IS NULL OR retail_price_rial > 0),
    received_qty           integer NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
    sold_qty               integer NOT NULL DEFAULT 0 CHECK (sold_qty >= 0),
    customer_returned_qty  integer NOT NULL DEFAULT 0 CHECK (customer_returned_qty >= 0),
    voided_qty             integer NOT NULL DEFAULT 0 CHECK (voided_qty >= 0),
    returned_to_owner_qty  integer NOT NULL DEFAULT 0 CHECK (returned_to_owner_qty >= 0),
    share_sold_rial        bigint NOT NULL DEFAULT 0 CHECK (share_sold_rial >= 0),
    share_returned_rial    bigint NOT NULL DEFAULT 0 CHECK (share_returned_rial >= 0),
    share_voided_rial      bigint NOT NULL DEFAULT 0 CHECK (share_voided_rial >= 0),
    commission_rial        bigint NOT NULL DEFAULT 0,
    -- Mirrors "contract not closed": an item is on at most one open line.
    is_open                boolean NOT NULL DEFAULT true,
    CHECK ((terms = 'owner_price' AND owner_unit_price_rial IS NOT NULL AND commission_bp IS NULL)
        OR (terms = 'commission' AND commission_bp IS NOT NULL AND owner_unit_price_rial IS NULL)),
    CHECK (received_qty - sold_qty + customer_returned_qty + voided_qty - returned_to_owner_qty >= 0),
    UNIQUE (contract_id, item_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fashion_consignment_lines_open_item_uq
    ON fashion_consignment_lines (item_id) WHERE is_open;

CREATE TABLE IF NOT EXISTS fashion_consignment_movements (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id         uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    contract_id         uuid NOT NULL REFERENCES fashion_consignment_contracts(id) ON DELETE RESTRICT,
    line_id             uuid NULL REFERENCES fashion_consignment_lines(id) ON DELETE RESTRICT,
    kind                text NOT NULL CHECK (kind IN ('receive', 'sale', 'customer_return', 'void', 'return_to_owner', 'settlement', 'close')),
    quantity            integer NULL CHECK (quantity IS NULL OR quantity > 0),
    net_rial            bigint NULL,
    owner_share_rial    bigint NULL,
    commission_rial     bigint NULL,
    amount_rial         bigint NULL CHECK (amount_rial IS NULL OR amount_rial > 0),
    order_id            uuid NULL REFERENCES orders(id) ON DELETE RESTRICT,
    order_item_id       uuid NULL REFERENCES order_items(id) ON DELETE RESTRICT,
    customer_return_id  uuid NULL REFERENCES customer_returns(id) ON DELETE RESTRICT,
    journal_entry_id    uuid NULL,
    idempotency_key     text NULL CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 200),
    request_hash        text NULL,
    note                text NULL CHECK (note IS NULL OR length(note) <= 1000),
    created_by          uuid NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fashion_consignment_movements_key_uq
    ON fashion_consignment_movements (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fashion_consignment_movements_sale_uq
    ON fashion_consignment_movements (order_item_id) WHERE kind IN ('sale', 'void');
CREATE INDEX IF NOT EXISTS fashion_consignment_movements_contract_idx
    ON fashion_consignment_movements (contract_id, created_at);
CREATE INDEX IF NOT EXISTS fashion_consignment_movements_order_item_idx
    ON fashion_consignment_movements (order_item_id) WHERE order_item_id IS NOT NULL;

-- The movement log is the audit trail of someone else's goods: never edited or deleted.
CREATE OR REPLACE FUNCTION reject_fashion_consignment_movement_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fashion_consignment_movements is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_fashion_consignment_movements_immutable ON fashion_consignment_movements;
CREATE TRIGGER trg_fashion_consignment_movements_immutable
    BEFORE UPDATE OR DELETE ON fashion_consignment_movements
    FOR EACH ROW EXECUTE FUNCTION reject_fashion_consignment_movement_mutation();

-- Owned and consigned units of one variant never mix: while a variant has
-- consigned units on hand, its owned item_stock may not grow (a purchase,
-- transfer, adjustment or return of an *owned* unit would otherwise blend
-- someone else's goods into the shop's carrying value).
CREATE OR REPLACE FUNCTION reject_owned_stock_on_consigned_variant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantity > COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.quantity END, 0)
     AND EXISTS (
       SELECT 1 FROM fashion_consignment_lines l
        WHERE l.item_id = NEW.item_id AND l.is_open
          AND l.received_qty - l.sold_qty + l.customer_returned_qty + l.voided_qty - l.returned_to_owner_qty > 0)
  THEN
    RAISE EXCEPTION 'consigned_variant_owned_stock' USING ERRCODE = 'P0001',
      HINT = 'This variant holds consigned units; return them to the owner before receiving owned stock.';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_item_stock_consigned_guard ON item_stock;
CREATE TRIGGER trg_item_stock_consigned_guard
    BEFORE INSERT OR UPDATE OF quantity ON item_stock
    FOR EACH ROW EXECUTE FUNCTION reject_owned_stock_on_consigned_variant();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fashion_consignment_contracts', 'fashion_consignment_lines', 'fashion_consignment_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL
                      USING (app_rls_bypass() OR business_id = app_current_business())
                      WITH CHECK (app_rls_bypass() OR business_id = app_current_business())', t);
  END LOOP;
END $$;
