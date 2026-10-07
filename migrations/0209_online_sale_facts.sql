-- Online (WooCommerce / Eshobe CMS) retail sales: one honest record per line
-- and per document (dashboard audit F01, F03, F04, F06).
--
-- Before this migration an imported online sale left three facts unrecorded:
--
--   * whether the line had a known cost. A line whose item had no
--     `item_stock.unit_cost` posted revenue and no COGS, and nothing anywhere
--     said so — the overview then showed the whole sale as profit;
--   * what happened to the shelf. The fungible path returned before the
--     quantity decrement when cost was missing, and otherwise relieved stock
--     with an unexplained `GREATEST(0, …)` clamp;
--   * when the sale happened. The order was opened/closed `now()` and the
--     journal dated CURRENT_DATE, so importing last month put it in today's
--     shift; discount/shipping/fees were dropped and the difference to the
--     remote total had nowhere to live.
--
-- Two tables and one column fix that, without reposting anything:
--
--   item_stock.remote_snapshot_at — set when an external store writes an
--     absolute quantity onto the row (a WooCommerce product snapshot). It is
--     the watermark the sale service compares a remote order's instant against
--     to decide whether the snapshot already contains that sale.
--
--   online_sale_lines — one row per sold order line: quantity, net, the cost
--     status, the COGS actually posted, and the stock outcome
--     (relieved / already_reflected / short / not_tracked / legacy). It is the
--     online channel's sale fact for the variant/brand reports (the counter
--     path keeps writing its `{trade}.sale_*` domain events) and the source of
--     the "provisional profit" exposure. A refund restores against it, so a
--     line that never relieved stock is never restocked, and a line that posted
--     no COGS never reverses any.
--
--   online_order_documents — one row per imported external order: the remote
--     created/paid/completed instants, the chosen occurrence instant and where
--     it came from, the import instant, and the remote component breakdown
--     with the unexplained difference stated rather than hidden.
--
-- Ownership: the ledger still owns balances, stock rows own quantities, the
-- external store owns its own document — these tables record what the import
-- did with it. Both are scoped like order_item_batch_allocations (migration
-- 0198): by their own location_id through app_owns_location.

ALTER TABLE item_stock ADD COLUMN remote_snapshot_at timestamptz;

COMMENT ON COLUMN item_stock.remote_snapshot_at IS
    'When an external store last set this row''s quantity absolutely (WooCommerce product snapshot). Compared against a remote order''s instant to avoid relieving a sale the snapshot already contains.';

CREATE TABLE online_order_documents (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id                   uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    location_id                uuid NOT NULL REFERENCES locations(id),
    source_type                text NOT NULL CHECK (source_type IN ('woocommerce_order', 'cms_store_order')),
    remote_id                  text NOT NULL,
    remote_number              text,
    remote_created_at          timestamptz,
    remote_paid_at             timestamptz,
    remote_completed_at        timestamptz,
    occurred_at                timestamptz NOT NULL,
    occurred_at_source         text NOT NULL
        CHECK (occurred_at_source IN ('remote_paid', 'remote_completed', 'remote_created', 'import')),
    imported_at                timestamptz NOT NULL DEFAULT now(),
    currency                   text,
    lines_subtotal_rial        bigint NOT NULL DEFAULT 0,
    discount_rial              bigint NOT NULL DEFAULT 0 CHECK (discount_rial >= 0),
    shipping_rial              bigint NOT NULL DEFAULT 0 CHECK (shipping_rial >= 0),
    fees_rial                  bigint NOT NULL DEFAULT 0,
    tax_rial                   bigint NOT NULL DEFAULT 0 CHECK (tax_rial >= 0),
    total_rial                 bigint NOT NULL CHECK (total_rial >= 0),
    -- total − (lines − discount + shipping + fees + tax). Zero when the remote
    -- document reconciles; anything else is shown, never silently absorbed.
    unexplained_difference_rial bigint NOT NULL DEFAULT 0,
    breakdown_status           text NOT NULL
        CHECK (breakdown_status IN ('reconciled', 'explained_difference', 'incomplete')),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    CHECK (unexplained_difference_rial
           = total_rial - (lines_subtotal_rial - discount_rial + shipping_rial + fees_rial + tax_rial)),
    CHECK ((breakdown_status = 'reconciled') = (unexplained_difference_rial = 0))
);

CREATE INDEX idx_online_order_documents_location_occurred
    ON online_order_documents (location_id, occurred_at);

ALTER TABLE online_order_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_order_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON online_order_documents FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

CREATE TABLE online_sale_lines (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_item_id       uuid NOT NULL UNIQUE REFERENCES order_items(id) ON DELETE CASCADE,
    order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    location_id         uuid NOT NULL REFERENCES locations(id),
    item_id             uuid REFERENCES items(id) ON DELETE RESTRICT,
    source_type         text NOT NULL CHECK (source_type IN ('woocommerce_order', 'cms_store_order')),
    quantity            numeric(24, 9) NOT NULL CHECK (quantity > 0),
    net_rial            bigint NOT NULL CHECK (net_rial >= 0),
    -- known: COGS posted for every unit; partial: some units had no cost basis
    -- (a shortfall); missing: no cost basis at all; not_applicable: the line
    -- landed on no stock-holding item. `unattributed` is only written by the
    -- legacy backfill for a pre-0209 line whose order posted a COGS total that
    -- cannot honestly be split back to lines.
    cost_status         text NOT NULL
        CHECK (cost_status IN ('known', 'partial', 'missing', 'not_applicable', 'unattributed')),
    cogs_rial           bigint NOT NULL DEFAULT 0 CHECK (cogs_rial >= 0),
    stock_outcome       text NOT NULL
        CHECK (stock_outcome IN ('relieved', 'already_reflected', 'short', 'not_tracked', 'legacy')),
    relieved_quantity   numeric(24, 9) NOT NULL DEFAULT 0 CHECK (relieved_quantity >= 0),
    short_quantity      numeric(24, 9) NOT NULL DEFAULT 0 CHECK (short_quantity >= 0),
    restored_quantity   numeric(24, 9) NOT NULL DEFAULT 0 CHECK (restored_quantity >= 0),
    restored_cogs_rial  bigint NOT NULL DEFAULT 0 CHECK (restored_cogs_rial >= 0 AND restored_cogs_rial <= cogs_rial),
    returned_quantity   numeric(24, 9) NOT NULL DEFAULT 0
        CHECK (returned_quantity >= 0 AND returned_quantity <= quantity),
    occurred_at         timestamptz NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (relieved_quantity + short_quantity <= quantity),
    CHECK (restored_quantity <= relieved_quantity),
    CHECK (cost_status <> 'known' OR short_quantity = 0)
);

CREATE INDEX idx_online_sale_lines_order ON online_sale_lines (order_id);
CREATE INDEX idx_online_sale_lines_item_occurred ON online_sale_lines (location_id, item_id, occurred_at);
CREATE INDEX idx_online_sale_lines_cost_gap
    ON online_sale_lines (location_id, occurred_at) WHERE cost_status IN ('partial', 'missing', 'unattributed');

ALTER TABLE online_sale_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_sale_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON online_sale_lines FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

-- Reference affinity: a fact's order line, order, item and branch must be one
-- and the same sale. RLS alone would accept a line of branch A's order filed
-- under branch B of the same business.
CREATE FUNCTION online_sale_line_affinity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
         WHERE oi.id = NEW.order_item_id
           AND oi.order_id = NEW.order_id
           AND o.location_id = NEW.location_id
           AND oi.location_id = NEW.location_id
    ) THEN
        RAISE EXCEPTION 'online_sale_line_affinity' USING ERRCODE = '23514';
    END IF;
    IF NEW.item_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM items i WHERE i.id = NEW.item_id AND i.location_id = NEW.location_id
    ) THEN
        RAISE EXCEPTION 'online_sale_line_item_affinity' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_online_sale_line_affinity
    BEFORE INSERT OR UPDATE OF order_item_id, order_id, location_id, item_id ON online_sale_lines
    FOR EACH ROW EXECUTE FUNCTION online_sale_line_affinity();

CREATE FUNCTION online_order_document_affinity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.location_id = NEW.location_id) THEN
        RAISE EXCEPTION 'online_order_document_affinity' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_online_order_document_affinity
    BEFORE INSERT OR UPDATE OF order_id, location_id ON online_order_documents
    FOR EACH ROW EXECUTE FUNCTION online_order_document_affinity();
