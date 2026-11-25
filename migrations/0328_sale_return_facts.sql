-- GH #1567 F4 — trade sales reports net of returns, and sale-time
-- merchandising snapshots (all trade-goods trades: accessories, cosmetics,
-- wholesale, tools & fittings, haberdashery, fashion_apparel).
--
-- 1. `sale_return_facts`: one row per returned order line, written in the
--    same transaction as the return (counter `createCustomerReturn`, online
--    `ingestRetailRefund`). It carries exactly what the ledger booked for that
--    line: the contra-revenue share of the refund (refund − VAT, allocated
--    across lines so the shares sum to the posted amount), the COGS actually
--    reversed (0 for a damaged/discarded return, which posts no reversal),
--    the disposition, the return's own date and the sale's frozen
--    merchandising snapshot. Reports read sale facts − return facts.
--
-- 2. `online_sale_lines.merch`: the website sale's frozen snapshot, the
--    counterpart of the `merch` key the counter now writes into its
--    `<trade>.sale_revenue` event payload and `order_items.retail_snapshot`.
--
-- Legacy rows are never invented: a pre-0328 return is backfilled with the
-- quantity it actually returned (and, for an online line, the COGS it
-- actually restored), `amounts_known = false`, and no snapshot; a pre-0328
-- sale has no `merch` and reports show it as unknown.

CREATE TABLE IF NOT EXISTS sale_return_facts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id         uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_item_id       uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    item_id             uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    source_type         text NOT NULL
        CHECK (source_type IN ('customer_return', 'online_refund', 'legacy_customer_return', 'legacy_online_refund')),
    source_id           text NOT NULL,
    quantity            numeric(24, 9) NOT NULL CHECK (quantity > 0),
    net_rial            bigint NOT NULL DEFAULT 0 CHECK (net_rial >= 0),
    cogs_rial           bigint NOT NULL DEFAULT 0 CHECK (cogs_rial >= 0),
    disposition         return_disposition NOT NULL,
    -- false only on backfilled legacy rows: the quantity is real, the refund
    -- share was never recorded per line and is left at 0, not guessed.
    amounts_known       boolean NOT NULL DEFAULT true,
    merch               jsonb,
    occurred_at         timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_type, source_id, order_item_id),
    CHECK (amounts_known OR net_rial = 0)
);

CREATE INDEX IF NOT EXISTS idx_sale_return_facts_location_occurred
    ON sale_return_facts (location_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_sale_return_facts_item ON sale_return_facts (item_id);
CREATE INDEX IF NOT EXISTS idx_sale_return_facts_order_item ON sale_return_facts (order_item_id);

ALTER TABLE sale_return_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_return_facts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sale_return_facts;
CREATE POLICY tenant_isolation ON sale_return_facts FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Reference affinity: the fact's order line, order, branch and tenant must be
-- one sale. RLS alone would accept branch A's order line filed under branch B.
CREATE OR REPLACE FUNCTION sale_return_fact_affinity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          JOIN locations l ON l.id = o.location_id
         WHERE oi.id = NEW.order_item_id
           AND o.id = NEW.order_id
           AND o.location_id = NEW.location_id
           AND l.business_id = NEW.business_id
    ) THEN
        RAISE EXCEPTION 'sale_return_fact_affinity_violation'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sale_return_fact_affinity ON sale_return_facts;
CREATE TRIGGER trg_sale_return_fact_affinity
    BEFORE INSERT OR UPDATE ON sale_return_facts
    FOR EACH ROW EXECUTE FUNCTION sale_return_fact_affinity();

ALTER TABLE online_sale_lines ADD COLUMN IF NOT EXISTS merch jsonb;

-- Legacy online refunds: online_sale_lines already recorded what came back
-- (returned quantity, restored COGS). Move that into return facts so the
-- report has a single return source; the refund's revenue share was never
-- recorded per line, so it stays unknown (0, amounts_known = false). A
-- reversed (voided) line drops out of the report entirely and needs none.
INSERT INTO sale_return_facts
    (business_id, location_id, order_id, order_item_id, item_id, source_type, source_id,
     quantity, net_rial, cogs_rial, disposition, amounts_known, merch, occurred_at)
SELECT l.business_id, f.location_id, f.order_id, f.order_item_id, f.item_id,
       'legacy_online_refund', f.order_item_id::text,
       f.returned_quantity, 0, f.restored_cogs_rial,
       CASE WHEN f.restored_quantity > 0 OR f.restored_cogs_rial > 0
            THEN 'restockable'::return_disposition ELSE 'discarded'::return_disposition END,
       false, NULL, f.occurred_at
  FROM online_sale_lines f
  JOIN locations l ON l.id = f.location_id
  JOIN order_items oi ON oi.id = f.order_item_id AND oi.status <> 'voided'
 WHERE f.item_id IS NOT NULL AND f.returned_quantity > 0
ON CONFLICT (source_type, source_id, order_item_id) DO NOTHING;

-- Legacy counter returns of items-model lines (a `retail_snapshot` of a
-- fungible kind, no online fact): the quantity is real, and a restockable
-- line's COGS reversal is recomputed by the very rule the return used (the
-- sale's own COGS entry prorated by returned/sold quantity); the per-line
-- refund share was booked at return level only, so it stays unknown.
INSERT INTO sale_return_facts
    (business_id, location_id, order_id, order_item_id, item_id, source_type, source_id,
     quantity, net_rial, cogs_rial, disposition, amounts_known, merch, occurred_at)
SELECT r.business_id, r.location_id, r.order_id, rl.order_item_id, oi.item_id,
       'legacy_customer_return', r.id::text,
       rl.quantity, 0,
       CASE WHEN rl.disposition = 'restockable' AND (oi.retail_snapshot ->> 'quantity') ~ '^[0-9]+(\.[0-9]+)?$'
                 AND (oi.retail_snapshot ->> 'quantity')::numeric > 0
                 AND jsonb_typeof(oi.retail_snapshot -> 'ledgerEntryIds') = 'array'
            THEN COALESCE((
                SELECT round(sum(jl.debit) * rl.quantity / (oi.retail_snapshot ->> 'quantity')::numeric)
                  FROM journal_entries je
                  JOIN journal_lines jl ON jl.entry_id = je.id
                 WHERE je.business_id = r.business_id
                   AND je.posting_kind ILIKE '%cogs%'
                   AND je.reverses_entry_id IS NULL
                   AND je.id::text IN (SELECT jsonb_array_elements_text(oi.retail_snapshot -> 'ledgerEntryIds'))
              ), 0)::bigint
            ELSE 0 END,
       rl.disposition, false, NULL, r.created_at
  FROM customer_return_lines rl
  JOIN customer_returns r ON r.id = rl.customer_return_id
  JOIN order_items oi ON oi.id = rl.order_item_id AND oi.status <> 'voided'
 WHERE oi.item_id IS NOT NULL
   AND oi.retail_snapshot ->> 'kind' IN ('accessory', 'stocked', 'cosmetic')
   AND NOT EXISTS (SELECT 1 FROM online_sale_lines f WHERE f.order_item_id = oi.id)
ON CONFLICT (source_type, source_id, order_item_id) DO NOTHING;
