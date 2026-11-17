-- ============================================================================
-- 0297_table_qr_identity.sql — ESH-147 / biza-miz#1305
--
-- A café customer scans the QR printed on a physical table. The QR carries an
-- opaque, rotatable token — never the table's uuid — and Biza resolves it to
-- the one tenant/site/location/table that printed it. ESH-150 (cms#197) sends
-- the same token with the checkout; ESH-146 (#1304) resolves it before it calls
-- the shared `createOrder()`.
--
-- Why a token table rather than a column on `dining_tables`:
--   * rotation must invalidate the old print without losing which table it
--     named, so the history is part of the design (status + rotated_from);
--   * the lookup is by hash, so an active token can be found without the
--     plaintext ever being compared in the database;
--   * revocation (lost print, table retired) is an auditable state, not a
--     nullable column that overwrites the previous value.
--
-- The plaintext is never stored: `token_hash` is the lookup key and
-- `token_ciphertext` is the re-renderable copy (the QR has to be printable a
-- second time), encrypted at rest through src/lib/integrations/secrets.ts —
-- the same at-rest rule as `eshobe_cms_connections.api_key_ciphertext`.
-- ============================================================================

CREATE TABLE table_qr_tokens (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id      uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    -- Deleting a table takes its printed QRs with it. Archiving
    -- (`is_active = false`) is the normal path and is rejected at resolution
    -- time instead, so the history survives.
    table_id         uuid NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
    token_hash       text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    token_ciphertext text NOT NULL,
    -- The first characters after the `tqr_` prefix, so staff can tell two
    -- prints apart on screen without the full token being readable.
    token_prefix     text NOT NULL CHECK (char_length(token_prefix) BETWEEN 6 AND 24),
    status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'rotated', 'revoked')),
    rotated_from     uuid REFERENCES table_qr_tokens(id) ON DELETE SET NULL,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    rotated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    revoked_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    rotated_at       timestamptz,
    revoked_at       timestamptz
);

-- Exactly one live token per table. Partial unique index rather than a
-- constraint so rotated/revoked history may repeat a table freely.
CREATE UNIQUE INDEX uq_table_qr_tokens_active_table
    ON table_qr_tokens (table_id) WHERE status = 'active';
CREATE INDEX idx_table_qr_tokens_tenant_table
    ON table_qr_tokens (business_id, location_id, table_id, created_at DESC);
CREATE INDEX idx_table_qr_tokens_business
    ON table_qr_tokens (business_id);

-- Tenant isolation — the standard template, verbatim.
ALTER TABLE table_qr_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_qr_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON table_qr_tokens FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Provenance: which print produced a dine-in order. Nullable because a till,
-- a reservation or an imported sale creates dine-in orders too. Nulling rather
-- than cascading keeps the sale when a token row is removed.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS table_qr_token_id uuid
        REFERENCES table_qr_tokens(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- The dine-in entitlement, separate from `reservations`.
--
-- `createOrder()` used to refuse a dine-in order unless `reservations` was on,
-- which made a café that only offers walk-in table service and no reservations
-- unable to take a table order at all — the gap the epic recorded. Table
-- service and reserving a table are two capabilities: a café can have the
-- first without the second, and a business can reserve without a QR-ordering
-- flow. The flag is verified against `business_features`/billing exactly like
-- every other gate key.
--
-- Default TRUE on purpose: dine-in was previously allowed whenever
-- `reservations` was on, so a default-OFF row would silently switch off table
-- service for every existing restaurant on upgrade. Operators turn it off per
-- business; a café whose `reservations` is off keeps dine-in because this row
-- is on.
-- ----------------------------------------------------------------------------
INSERT INTO feature_flags (key, name, description, default_enabled)
VALUES (
    'dine_in',
    'سرویس حضوری روی میز',
    'ثبت سفارش حضوری روی میز (از جمله سفارش با QR میز) بدون نیاز به فعال بودن رزرو میز',
    true
)
ON CONFLICT (key) DO NOTHING;
