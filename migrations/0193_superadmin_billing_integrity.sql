-- ============================================================================
-- 0192_superadmin_billing_integrity.sql — payment authority & gateway_ref
-- integrity, durable post-payment fulfilment, serialized invoice payments,
-- spend warning/throttle tracking, and invoice line price-version snapshots.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Payment gateway environment binding & durable fulfilment state
-- ---------------------------------------------------------------------------
ALTER TABLE billing_payments
    ADD COLUMN IF NOT EXISTS sandbox boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS fulfilment_status text NOT NULL DEFAULT 'pending'
        CHECK (fulfilment_status IN ('pending', 'succeeded', 'failed')),
    ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz,
    ADD COLUMN IF NOT EXISTS fulfilment_error text;

UPDATE billing_payments
   SET fulfilment_status = 'succeeded',
       fulfilled_at = COALESCE(verified_at, created_at)
 WHERE status = 'verified' AND fulfilment_status = 'pending';

-- Deduplicate any pre-existing colliding gateway_ref values per (gateway, sandbox)
-- before enforcing the unique index.
WITH dupes AS (
    SELECT id,
           gateway_ref,
           row_number() OVER (
               PARTITION BY gateway, sandbox, gateway_ref
               ORDER BY (status = 'verified') DESC, created_at ASC, id ASC
           ) AS rn
      FROM billing_payments
     WHERE gateway_ref IS NOT NULL AND btrim(gateway_ref) <> ''
)
UPDATE billing_payments p
   SET gateway_ref = p.gateway_ref || '#dup-' || d.rn::text
  FROM dupes d
 WHERE p.id = d.id AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payments_gateway_ref_unique
    ON billing_payments (gateway, sandbox, gateway_ref)
 WHERE gateway_ref IS NOT NULL AND btrim(gateway_ref) <> '';

-- ---------------------------------------------------------------------------
-- 2. Auditable, idempotent invoice payment records
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_invoice_payments (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id         uuid NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    amount_rial        bigint NOT NULL CHECK (amount_rial > 0),
    idempotency_key    text,
    payment_id         uuid REFERENCES billing_payments(id) ON DELETE SET NULL,
    note               text,
    platform_admin_id  uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (invoice_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_billing_invoice_payments_invoice
    ON billing_invoice_payments (invoice_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_invoice_payments_business
    ON billing_invoice_payments (business_id, created_at DESC);

ALTER TABLE billing_invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoice_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing_invoice_payments;
CREATE POLICY tenant_isolation ON billing_invoice_payments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. Invoice line price-version snapshot metadata
-- ---------------------------------------------------------------------------
ALTER TABLE billing_invoice_lines
    ADD COLUMN IF NOT EXISTS price_version_id uuid REFERENCES billing_price_versions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 4. Spend policy warning delivery & throttling telemetry
-- ---------------------------------------------------------------------------
ALTER TABLE business_spend_policies
    ADD COLUMN IF NOT EXISTS last_warned_period text,
    ADD COLUMN IF NOT EXISTS last_warning_threshold integer,
    ADD COLUMN IF NOT EXISTS last_warning_at timestamptz,
    ADD COLUMN IF NOT EXISTS warning_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS throttled_at timestamptz,
    ADD COLUMN IF NOT EXISTS throttle_count integer NOT NULL DEFAULT 0;
