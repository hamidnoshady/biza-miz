-- ============================================================================
-- 0237_billing_tenant_audit_fix.sql — Fix #928 tenant subscription & billing
--
-- P0: paid same-plan purchase may provide no additional service period
-- P1: purchased/manual entitlements overwritten by plan restamping
-- P1: gateway settlement / config drift / callback / currency fixes
-- P1: atomic plan transitions & entitlement reconciliation
-- Adds idempotency, gateway/quote snapshots, and fulfillment tracking.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Payment idempotency & snapshots (P0, P1 gateway drift)
-- ---------------------------------------------------------------------------
ALTER TABLE billing_payments
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS gateway_snapshot jsonb,
    ADD COLUMN IF NOT EXISTS quote_snapshot jsonb;

-- Idempotency per business: same business cannot have two pending payments
-- with the same idempotency key (client-generated, e.g. quoteId + timestamp)
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payments_idempotency
    ON billing_payments (business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

-- ---------------------------------------------------------------------------
-- 2. Ensure fulfilment columns exist (from 0193, but guard)
-- ---------------------------------------------------------------------------
ALTER TABLE billing_payments
    ADD COLUMN IF NOT EXISTS sandbox boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS fulfilment_status text NOT NULL DEFAULT 'pending'
        CHECK (fulfilment_status IN ('pending', 'succeeded', 'failed')),
    ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz,
    ADD COLUMN IF NOT EXISTS fulfilment_error text;

-- ---------------------------------------------------------------------------
-- 3. Business entitlements: add partial index to aid reconciling plan-source
--    entitlements separately from owned ones.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_business_entitlements_source_plan
    ON business_entitlements (business_id, source)
    WHERE source = 'plan';

-- ---------------------------------------------------------------------------
-- 4. Callback URL validation helper (informational; enforced in app code)
--    Platform payment config callback_url should point to canonical handler:
--    /api/billing/payments/callback, not the legacy tenant path.
-- ---------------------------------------------------------------------------
-- No schema change for callback; app validates HTTPS and path.

-- ---------------------------------------------------------------------------
-- 5. Document commercial settings minimum top-up is authoritative
-- ---------------------------------------------------------------------------
-- Already enforced in code: POST /api/billing/payments and /api/billing/quote
-- both read billing_commercial_settings.minimum_top_up_rial and reject below min.
