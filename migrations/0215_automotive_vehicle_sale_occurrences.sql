-- ============================================================================
-- 0215_automotive_vehicle_sale_occurrences.sql — preserve returned-sale facts
-- while making the vehicle's current-sale fields available for a later resale.
--
-- `automotive_vehicle_attributes` is the live state of one car. Its sold_* and
-- frozen-cost fields describe the CURRENT active sale and must be cleared when
-- that sale is reversed; otherwise the unique sold_order_item index prevents a
-- returned car from ever being sold again. The occurrence table is the durable
-- history of every sale/reversal, including the exact ledger entries mirrored
-- by a return. It uses the same tenant boundary as the vehicle and leaves the
-- invoice, order-item, parties and journal as their canonical owners.
--
-- Forward-only: legacy sale ids and posting ids are recovered from the durable
-- domain event / retail line snapshot before current facts are cleared. No
-- journal or invoice ownership is copied or rewritten.
-- ============================================================================

CREATE TABLE automotive_vehicle_sales (
    sale_id                    uuid PRIMARY KEY,
    business_id                uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id                uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    serial_id                  uuid NOT NULL REFERENCES automotive_vehicle_attributes(serial_id) ON DELETE RESTRICT,
    order_id                   uuid REFERENCES orders(id) ON DELETE SET NULL,
    order_item_id              uuid REFERENCES order_items(id) ON DELETE SET NULL,
    customer_id                uuid REFERENCES parties(id) ON DELETE SET NULL,
    sold_on                    date NOT NULL,
    acquired_on                date,
    stock_number               text NOT NULL,
    make                       text NOT NULL,
    model                      text NOT NULL,
    trim                       text,
    model_year                 integer,
    condition                  text NOT NULL CHECK (condition IN ('new', 'used')),
    sale_price_rial            bigint NOT NULL CHECK (sale_price_rial >= 0),
    vat_rate_percent           numeric(5,2) CHECK (vat_rate_percent IS NULL OR vat_rate_percent BETWEEN 0 AND 100),
    frozen_effective_cost_rial bigint CHECK (frozen_effective_cost_rial IS NULL OR frozen_effective_cost_rial >= 0),
    sold_by                    uuid REFERENCES users(id) ON DELETE SET NULL,
    sale_entry_ids             uuid[] NOT NULL DEFAULT '{}',
    status                     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reversed')),
    reversal_reason            text,
    reversal_entry_ids         uuid[] NOT NULL DEFAULT '{}',
    reversed_by                uuid REFERENCES users(id) ON DELETE SET NULL,
    reversed_at                timestamptz,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT automotive_vehicle_sale_reversal_shape CHECK (
      (status = 'active' AND reversal_reason IS NULL AND reversed_at IS NULL) OR
      (status = 'reversed' AND reversal_reason IS NOT NULL AND length(btrim(reversal_reason)) > 0 AND reversed_at IS NOT NULL)
    )
);

-- Keep the already-sold units reversible and reportable after upgrade. The
-- occurrence identity is the original posting source_id whenever the sale's
-- event or canonical retail-line snapshot still identifies it; only a legacy
-- sale with neither record receives a synthetic history-only id.
INSERT INTO automotive_vehicle_sales (
    sale_id, business_id, location_id, serial_id, order_id, order_item_id,
    customer_id, sold_on, acquired_on, stock_number, make, model, trim, model_year,
    condition, sale_price_rial, vat_rate_percent, frozen_effective_cost_rial,
    sold_by, sale_entry_ids, status, reversal_reason, reversal_entry_ids,
    reversed_by, reversed_at, created_at
)
SELECT coalesce(sale_event.source_id, snapshot_sale.source_id, gen_random_uuid()),
       v.business_id, v.location_id, v.serial_id, v.sold_order_id,
       v.sold_order_item_id, v.sold_customer_id, v.sold_on,
       coalesce(v.acquisition_date, v.created_at::date), v.stock_number, v.make, v.model,
       v.trim, v.model_year, v.condition, v.sale_price_rial,
       CASE
         WHEN coalesce(nullif(sale_event.payload->>'net', '')::numeric, 0) > 0
           THEN round(nullif(sale_event.payload->>'vat', '')::numeric * 100
                      / nullif(sale_event.payload->>'net', '')::numeric, 2)
         ELSE NULL
       END,
       v.frozen_effective_cost_rial, v.sold_by,
       ARRAY(
         SELECT DISTINCT entry_id::uuid
           FROM (
             SELECT ids.entry_id
               FROM jsonb_array_elements_text(
                      CASE WHEN jsonb_typeof(oi.retail_snapshot->'ledgerEntryIds') = 'array'
                           THEN oi.retail_snapshot->'ledgerEntryIds' ELSE '[]'::jsonb END
                    ) AS ids(entry_id)
              WHERE ids.entry_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             UNION
             SELECT e.id::text
               FROM journal_entries e
              WHERE e.business_id = v.business_id
                AND e.source_type = 'automotive_sale'
                AND e.source_id = coalesce(sale_event.source_id, snapshot_sale.source_id)
           ) AS legacy_entries(entry_id)
          ORDER BY entry_id::uuid
       ),
       CASE WHEN v.state = 'returned' THEN 'reversed' ELSE 'active' END,
       CASE WHEN v.state = 'returned'
            THEN coalesce(reversal_event.payload->>'reason', 'Historical return before sale-occurrence tracking') END,
       ARRAY(
         SELECT DISTINCT entry_id::uuid
           FROM jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(reversal_event.payload->'reversedEntryIds') = 'array'
                       THEN reversal_event.payload->'reversedEntryIds' ELSE '[]'::jsonb END
                ) AS reversed_entries(entry_id)
          WHERE entry_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          ORDER BY entry_id::uuid
       ),
       reversal_event.created_by,
       CASE WHEN v.state = 'returned' THEN coalesce(reversal_event.created_at, v.updated_at) END,
       v.updated_at
  FROM automotive_vehicle_attributes v
  LEFT JOIN order_items oi
    ON oi.id = v.sold_order_item_id AND oi.order_id = v.sold_order_id
  LEFT JOIN LATERAL (
       SELECT e.source_id, e.payload
         FROM domain_events e
        WHERE e.business_id = v.business_id
          AND e.event_type = 'automotive.sale_revenue'
          AND e.payload->>'serialId' = v.serial_id::text
          AND (v.sold_order_id IS NULL OR e.payload->>'orderId' = v.sold_order_id::text)
        ORDER BY (e.created_at::date = v.sold_on) DESC, e.created_at DESC
        LIMIT 1
  ) sale_event ON true
  LEFT JOIN LATERAL (
       SELECT e.source_id
         FROM jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(oi.retail_snapshot->'ledgerEntryIds') = 'array'
                     THEN oi.retail_snapshot->'ledgerEntryIds' ELSE '[]'::jsonb END
              ) AS ids(entry_id)
         JOIN journal_entries e
           ON e.id = CASE
                WHEN ids.entry_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN ids.entry_id::uuid ELSE NULL END
          AND e.business_id = v.business_id
          AND e.source_type = 'automotive_sale'
        ORDER BY (e.posting_kind = 'automotive_sale_revenue') DESC, e.posted_at DESC
        LIMIT 1
  ) snapshot_sale ON true
  LEFT JOIN LATERAL (
       SELECT e.payload, e.created_at, e.created_by
         FROM domain_events e
        WHERE e.business_id = v.business_id
          AND e.event_type = 'automotive.sale_reversed'
          AND e.payload->>'serialId' = v.serial_id::text
          AND (v.sold_order_id IS NULL OR e.payload->>'orderId' = v.sold_order_id::text)
        ORDER BY (e.created_at::date = v.sold_on) DESC, e.created_at DESC
        LIMIT 1
  ) reversal_event ON true
 WHERE v.sold_on IS NOT NULL
ON CONFLICT DO NOTHING;

-- A previously returned car gets a clear live-sale slot after its facts are
-- safely copied to the occurrence row. The order line, journal and history
-- remain untouched.
UPDATE automotive_vehicle_attributes
   SET sold_order_id = NULL, sold_order_item_id = NULL, sold_customer_id = NULL,
       sold_on = NULL, sale_price_rial = NULL, frozen_effective_cost_rial = NULL,
       sold_by = NULL, updated_at = now()
 WHERE state = 'returned' AND sold_on IS NOT NULL;

UPDATE item_serials s
   SET sold_at = NULL
  FROM automotive_vehicle_attributes v
 WHERE v.serial_id = s.id AND v.state = 'returned' AND v.sold_on IS NULL;

CREATE UNIQUE INDEX uq_automotive_vehicle_one_active_sale
    ON automotive_vehicle_sales (business_id, serial_id) WHERE status = 'active';
CREATE UNIQUE INDEX uq_automotive_vehicle_sale_order_item
    ON automotive_vehicle_sales (order_item_id) WHERE order_item_id IS NOT NULL;
CREATE INDEX idx_automotive_vehicle_sales_history
    ON automotive_vehicle_sales (business_id, serial_id, sold_on DESC, created_at DESC);
CREATE INDEX idx_automotive_vehicle_sales_business_day
    ON automotive_vehicle_sales (business_id, location_id, sold_on DESC);

ALTER TABLE automotive_vehicle_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE automotive_vehicle_sales FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automotive_vehicle_sales FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
