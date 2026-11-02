-- Issue #902 §4 — RETAIL pricing for the managed messaging service.
--
-- The provider bills the platform one number (wholesale, per child account and
-- per tariff bucket) and Biza-Miz bills the business another (retail, in Rial,
-- out of the ONE platform wallet). Until now the retail side was a single
-- number on `platform_message_config.sms_rial_per_segment` — correct but flat:
-- no markup policy, no surcharge, no volume tiers, no per-business exception,
-- no tax line, and no record of which price was in force when a reservation was
-- taken.
--
-- This migration adds the *policy* half, versioned and effective-dated, and
-- keeps `platform_message_config` as the base rate it applies to. That ordering
-- matters for compatibility: with no version published, retail is exactly
-- `rate × quantity`, byte for byte the amount Wave 1 reserved. Publishing a
-- version is the only thing that changes a tenant's price, and it is an audited
-- Superadmin act.
--
--   * `kavenegar_retail_price_versions` — one row per published price policy:
--     percentage markup, fixed per-message surcharge, volume-slab defaults,
--     discount (promotion) window, tax/fee rate, free monthly allowance, and
--     the failure policy ("was this send billed?").
--   * `kavenegar_retail_price_slabs`   — volume tiers: from N monthly segments
--     onward, a different markup/surcharge.
--   * `kavenegar_retail_price_overrides` — per-channel and per-business
--     exceptions, because one enterprise contract should not be a platform-wide
--     price change.
--
-- Only ONE version may be open (`effective_until IS NULL`) at a time; a new
-- publish closes the old one at the new version's `effective_from`. A
-- reservation picks the version whose window contains `now()` and records its
-- version number on the wallet entry, so settlement never re-prices and a later
-- publish cannot retroactively change a send already in flight.
--
-- `tenant_visible` on `billing_vendor_cost_events`: §0 and DoD #3 say a tenant
-- must never see supplier cost, supplier name or private margin — in any UI,
-- API, export or sync. The managed-service cost rows therefore carry
-- `tenant_visible = false`, and a RESTRICTIVE policy ANDs with the existing
-- permissive `tenant_isolation` policy, so those rows are unreadable through a
-- tenant connection even if a future tenant-facing query forgets to filter.
-- Existing rows default to `true`, so nothing else changes.

-- ---------------------------------------------------------------------------
-- Price versions
-- ---------------------------------------------------------------------------

CREATE TABLE kavenegar_retail_price_versions (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version                 integer NOT NULL UNIQUE CHECK (version > 0),
    effective_from          timestamptz NOT NULL DEFAULT now(),
    effective_until         timestamptz,
    -- 0 = charge the Billing base rate unchanged. 1250 = +12.5%.
    markup_bps              integer NOT NULL DEFAULT 0
                                CHECK (markup_bps BETWEEN 0 AND 100_000),
    -- Once per message, not per segment: a handling fee, not a per-SMS price.
    fixed_surcharge_rial    bigint NOT NULL DEFAULT 0 CHECK (fixed_surcharge_rial >= 0),
    discount_bps            integer NOT NULL DEFAULT 0
                                CHECK (discount_bps BETWEEN 0 AND 10_000),
    -- A promotion is time-boxed. NULL = the discount has no end date.
    discount_until          timestamptz,
    tax_bps                 integer NOT NULL DEFAULT 0 CHECK (tax_bps BETWEEN 0 AND 10_000),
    -- Segments per business per calendar month charged at zero. 0 = none.
    free_allowance_segments integer NOT NULL DEFAULT 0
                                CHECK (free_allowance_segments BETWEEN 0 AND 10_000_000),
    -- 'refund' — a send the provider never accepted is not charged to the
    --            tenant (the reservation is refunded in full).
    -- 'charge' — the tenant pays for the attempt (used only where the supplier
    --            actually bills attempts; never assumed).
    failed_send_policy      text NOT NULL DEFAULT 'refund'
                                CHECK (failed_send_policy IN ('refund', 'charge')),
    note                    text,
    created_by              uuid,
    created_at              timestamptz NOT NULL DEFAULT now(),
    CHECK (effective_until IS NULL OR effective_until > effective_from),
    CHECK (discount_until IS NULL OR discount_until > effective_from)
);

-- Exactly one open version. The index is on a constant, so a second row with
-- `effective_until IS NULL` collides regardless of its other columns.
CREATE UNIQUE INDEX kavenegar_retail_price_versions_one_open
    ON kavenegar_retail_price_versions ((true))
    WHERE effective_until IS NULL;

CREATE INDEX idx_kavenegar_retail_price_versions_window
    ON kavenegar_retail_price_versions (effective_from DESC);

-- ---------------------------------------------------------------------------
-- Volume slabs — the tier is chosen by the business's segments in the current
-- UTC calendar month, at reservation time, and the tier REPLACES the version's
-- markup/surcharge (a slab is a price, not a discount on top of one).
-- ---------------------------------------------------------------------------

CREATE TABLE kavenegar_retail_price_slabs (
    version_id          uuid NOT NULL
                            REFERENCES kavenegar_retail_price_versions(id) ON DELETE CASCADE,
    min_monthly_segments bigint NOT NULL CHECK (min_monthly_segments >= 0),
    markup_bps          integer NOT NULL CHECK (markup_bps BETWEEN 0 AND 100_000),
    fixed_surcharge_rial bigint NOT NULL DEFAULT 0 CHECK (fixed_surcharge_rial >= 0),
    PRIMARY KEY (version_id, min_monthly_segments)
);

-- ---------------------------------------------------------------------------
-- Exceptions — per channel and/or per business. Applied in order
-- channel → business → business_channel, each overriding only the fields it
-- sets, so the most specific row wins and an unset field keeps the slab price.
-- ---------------------------------------------------------------------------

CREATE TABLE kavenegar_retail_price_overrides (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id           uuid NOT NULL
                             REFERENCES kavenegar_retail_price_versions(id) ON DELETE CASCADE,
    scope                text NOT NULL
                             CHECK (scope IN ('channel', 'business', 'business_channel')),
    -- Deliberately NOT named `business_id`: this is a TARGETING key on a
    -- platform commercial policy, not tenant-owned data, and the tenancy sweep
    -- treats `business_id` as ownership. The row stays platform-only.
    scope_business_id    uuid REFERENCES businesses(id) ON DELETE CASCADE,
    channel              text CHECK (channel IN ('sms', 'email')),
    markup_bps           integer CHECK (markup_bps BETWEEN 0 AND 100_000),
    fixed_surcharge_rial bigint CHECK (fixed_surcharge_rial >= 0),
    note                 text,
    CHECK (
        (scope = 'channel' AND scope_business_id IS NULL AND channel IS NOT NULL)
        OR (scope = 'business' AND scope_business_id IS NOT NULL AND channel IS NULL)
        OR (scope = 'business_channel' AND scope_business_id IS NOT NULL AND channel IS NOT NULL)
    )
);

CREATE UNIQUE INDEX kavenegar_retail_price_overrides_unique
    ON kavenegar_retail_price_overrides (
        version_id,
        scope,
        coalesce(scope_business_id, '00000000-0000-0000-0000-000000000000'::uuid),
        coalesce(channel, '')
    );
CREATE INDEX idx_kavenegar_retail_price_overrides_business
    ON kavenegar_retail_price_overrides (scope_business_id)
    WHERE scope_business_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS — retail price policy is platform commercial data. A business sees the
-- price it is charged (in its wallet and usage), never the policy, the markup
-- or the margins behind it.
-- ---------------------------------------------------------------------------

ALTER TABLE kavenegar_retail_price_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kavenegar_retail_price_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON kavenegar_retail_price_versions FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

ALTER TABLE kavenegar_retail_price_slabs ENABLE ROW LEVEL SECURITY;
ALTER TABLE kavenegar_retail_price_slabs FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON kavenegar_retail_price_slabs FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

ALTER TABLE kavenegar_retail_price_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE kavenegar_retail_price_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON kavenegar_retail_price_overrides FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

-- ---------------------------------------------------------------------------
-- Supplier cost is internal. The existing `tenant_isolation` policy on
-- billing_vendor_cost_events stays (permissive, so the tenant's own visible
-- rows still read); this RESTRICTIVE policy ANDs with it and hides the rows
-- flagged internal from every non-bypass connection.
-- ---------------------------------------------------------------------------

ALTER TABLE billing_vendor_cost_events
    ADD COLUMN tenant_visible boolean NOT NULL DEFAULT true;

CREATE POLICY managed_cost_is_internal ON billing_vendor_cost_events
    AS RESTRICTIVE FOR SELECT
    USING (tenant_visible OR app_rls_bypass());

COMMENT ON TABLE kavenegar_retail_price_versions IS
    'Issue #902 §4: effective-dated retail price policy (markup, surcharge, tax, discount, free allowance, failure policy) applied on top of platform_message_config rates.';
COMMENT ON TABLE kavenegar_retail_price_slabs IS
    'Issue #902 §4: volume tiers by segments in the current UTC month; a tier replaces the version markup/surcharge.';
COMMENT ON TABLE kavenegar_retail_price_overrides IS
    'Issue #902 §4: per-channel / per-business retail exceptions; most specific scope wins.';
COMMENT ON COLUMN billing_vendor_cost_events.tenant_visible IS
    'Issue #902 §0: false for managed-service supplier cost, which must never reach a tenant view, export or sync.';
