-- ============================================================================
-- 0304_billing_coupons_and_quote_store.sql — ESH-193 / #1378 stages 2–3.
--
-- Three additions to the commercial domain, all on top of tables that already
-- existed (no second price catalogue):
--
--   1. `billing_coupons` — one row per code. A coupon is either a percentage
--      of the post-term-discount recurring total (basis points, so 5% is 500)
--      or a flat Rial amount, never both. Windows, eligible terms and usage
--      caps are data, not code.
--   2. `billing_coupon_redemptions` — the hold and its outcome. A quote
--      reserves at most one coupon for one business; payment redeems it; an
--      abandoned quote releases it when the hold expires. The partial unique
--      indexes make "one open hold per business per coupon" and "one redemption
--      per quote" database facts rather than service conventions.
--   3. `billing_quotes` — the quote as it was shown. Persisting it is what lets
--      the payment boundary compare a *stored* price with a freshly read one
--      and refuse a stale quote instead of silently charging today's price.
--
-- The global cap on a coupon is spent at *redemption*, inside the same
-- transaction that consumes the quote: `billing_coupons.redeemed_count` is
-- incremented with a `redeemed_count < max_redemptions` predicate, so the
-- loser of a race rolls back the whole settlement. Reservations are a hold, not
-- a spend — otherwise an abandoned checkout would exhaust a campaign.
--
-- Tenant-owned tables (`billing_quotes`, redemptions) get the same forced-RLS
-- policy as the wallet: only the owning business sees them. The coupon
-- catalogue is global and carries no tenant column, like `billing_plans`.
--
-- Rollback: additive. Dropping the two tenant tables and the coupon catalogue
-- restores 0303; no existing table is altered.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Coupon catalogue (global)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_coupons (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code                        citext NOT NULL UNIQUE CHECK (length(trim(code)) BETWEEN 2 AND 64),
    description                 text NOT NULL DEFAULT '',
    discount_kind               text NOT NULL CHECK (discount_kind IN ('percent', 'fixed')),
    -- 'percent': basis points of the recurring total after the term discount.
    -- 'fixed':   Rial, clamped to that same base.
    percent_basis_points        integer CHECK (percent_basis_points BETWEEN 1 AND 10000),
    amount_rial                 bigint CHECK (amount_rial > 0),
    -- Which terms may use it. 1 = every term, 3 = only 3- and 12-month,
    -- 12 = only annual.
    min_term_months             integer NOT NULL DEFAULT 1 CHECK (min_term_months IN (1, 3, 12)),
    valid_from                  timestamptz NOT NULL DEFAULT now(),
    valid_until                 timestamptz,
    max_redemptions             integer CHECK (max_redemptions IS NULL OR max_redemptions > 0),
    max_redemptions_per_business integer NOT NULL DEFAULT 1 CHECK (max_redemptions_per_business > 0),
    -- Spent only by `consumeQuote`; see the header.
    redeemed_count              integer NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
    status                      text NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'paused', 'retired')),
    created_by                  uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (discount_kind = 'percent' AND percent_basis_points IS NOT NULL AND amount_rial IS NULL)
        OR (discount_kind = 'fixed' AND amount_rial IS NOT NULL AND percent_basis_points IS NULL)
    ),
    CHECK (valid_until IS NULL OR valid_until > valid_from),
    CHECK (max_redemptions IS NULL OR redeemed_count <= max_redemptions)
);

CREATE INDEX IF NOT EXISTS idx_billing_coupons_active
    ON billing_coupons (status, valid_until)
 WHERE status = 'active';

COMMENT ON TABLE billing_coupons IS
    'Single-use-per-business commercial codes (ESH-193). One coupon per quote; percentages are basis points of the post-term-discount recurring total.';

-- ---------------------------------------------------------------------------
-- Persisted quotes (tenant-owned)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_quotes (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id              uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- One audit actor: the global person, never a membership id.
    platform_user_id         uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
    plan_key                 text NOT NULL REFERENCES billing_plans(key) ON DELETE RESTRICT,
    term_months              integer NOT NULL CHECK (term_months IN (1, 3, 12)),
    -- The inputs needed to re-price: rates are stored as integers so no
    -- floating comparison decides whether a quote is stale.
    term_discount_basis_points integer NOT NULL CHECK (term_discount_basis_points BETWEEN 0 AND 10000),
    tax_basis_points         integer NOT NULL CHECK (tax_basis_points BETWEEN 0 AND 10000),
    coupon_id                uuid REFERENCES billing_coupons(id) ON DELETE RESTRICT,
    coupon_code              text,
    coupon_kind              text CHECK (coupon_kind IN ('percent', 'fixed')),
    coupon_value             integer CHECK (coupon_value > 0),
    gross_rial               bigint NOT NULL CHECK (gross_rial >= 0),
    discount_rial            bigint NOT NULL CHECK (discount_rial >= 0),
    coupon_discount_rial     bigint NOT NULL DEFAULT 0 CHECK (coupon_discount_rial >= 0),
    tax_rial                 bigint NOT NULL CHECK (tax_rial >= 0),
    net_rial                 bigint NOT NULL CHECK (net_rial >= 0),
    -- The itemised lines exactly as shown, including their price versions.
    lines                    jsonb NOT NULL,
    base_price_version_id    text NOT NULL,
    base_price_version       integer NOT NULL CHECK (base_price_version >= 0),
    period_start             timestamptz NOT NULL,
    period_end               timestamptz NOT NULL,
    issued_at                timestamptz NOT NULL,
    expires_at               timestamptz NOT NULL,
    status                   text NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open', 'consumed', 'expired', 'cancelled')),
    payment_id               uuid,
    consumed_at              timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),
    CHECK (period_end > period_start),
    CHECK (expires_at > issued_at),
    CHECK (coupon_id IS NULL OR (coupon_code IS NOT NULL AND coupon_kind IS NOT NULL AND coupon_value IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_billing_quotes_business_created
    ON billing_quotes (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_quotes_open_expiry
    ON billing_quotes (expires_at)
 WHERE status = 'open';
-- A payment can consume at most one quote.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_quotes_payment
    ON billing_quotes (payment_id)
 WHERE payment_id IS NOT NULL;

COMMENT ON TABLE billing_quotes IS
    'The quote as shown, with the inputs needed to re-price it (ESH-193). The payment boundary compares it with live prices and refuses stale/expired quotes.';

-- ---------------------------------------------------------------------------
-- Coupon holds and redemptions (tenant-owned)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_coupon_redemptions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    coupon_id      uuid NOT NULL REFERENCES billing_coupons(id) ON DELETE RESTRICT,
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    quote_id       uuid REFERENCES billing_quotes(id) ON DELETE SET NULL,
    status         text NOT NULL DEFAULT 'reserved'
                       CHECK (status IN ('reserved', 'redeemed', 'released')),
    -- The coupon's Rial contribution on the quote that holds it.
    amount_rial    bigint NOT NULL CHECK (amount_rial >= 0),
    reserved_until timestamptz NOT NULL,
    redeemed_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- One open hold per business per coupon, and at most one redemption per
-- business per coupon at a time. The service releases expired holds first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_redemptions_one_open
    ON billing_coupon_redemptions (coupon_id, business_id)
 WHERE status = 'reserved';
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_redemptions_quote
    ON billing_coupon_redemptions (quote_id)
 WHERE quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_expiry
    ON billing_coupon_redemptions (reserved_until)
 WHERE status = 'reserved';

COMMENT ON TABLE billing_coupon_redemptions IS
    'Coupon holds and their outcome (ESH-193). A hold expires with its quote; only a redeemed row spends a coupon, and the per-business caps are counted here.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE billing_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_quotes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_quotes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE billing_coupon_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_coupon_redemptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_coupon_redemptions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
