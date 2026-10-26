-- ============================================================================
-- 0257_credit_lease_policy.sql — issue #998, Phase 0: the data-driven settings
-- and meter registry for credit leases on Hybrid and Full Offline installs.
--
-- Decisions of 2026-10-18 and the Phase 0 proposal agreed 2026-10-25:
--   * a lease reserves wallet credit and is sized for a 7-day offline window;
--   * use beyond the lease continues as debt, up to a superadmin-set ceiling;
--   * at the ceiling the plan's lock policy applies;
--   * which functions are metered is data, so the superadmin can mark another
--     one later without a code change.
--
-- Nothing reads these tables yet: they are the contract the lease issuer
-- (Phase 1) and the site metering helper (Phase 2) will read. All three
-- meters are seeded in `shadow`, i.e. measured and rated but never enforced,
-- and carry no price: prices live in `billing_price_versions` and are set by
-- the owner after the shadow comparison.
--
-- Global catalogues with no business_id, like billing_meters and
-- billing_plans: they are listed in EXEMPT_TABLES (src/lib/tenant-tables.ts).
-- ============================================================================

-- One row of global defaults.
CREATE TABLE credit_lease_defaults (
    id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
    offline_window_days     integer NOT NULL DEFAULT 7
                                CHECK (offline_window_days BETWEEN 1 AND 30),
    debt_ceiling_rial       bigint NOT NULL DEFAULT 10000000
                                CHECK (debt_ceiling_rial >= 0),
    -- Basis points of the normal unit price charged for over-lease usage;
    -- 10000 = 1.0x. Integer so rating never touches a float.
    over_lease_price_bps    integer NOT NULL DEFAULT 10000
                                CHECK (over_lease_price_bps BETWEEN 1 AND 1000000),
    lock_policy             text NOT NULL DEFAULT 'read_only'
                                CHECK (lock_policy IN ('block', 'read_only')),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

INSERT INTO credit_lease_defaults (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- A plan overrides the default field by field; NULL falls through.
CREATE TABLE credit_lease_plan_overrides (
    plan_key                text PRIMARY KEY REFERENCES billing_plans(key) ON DELETE CASCADE,
    offline_window_days     integer CHECK (offline_window_days IS NULL OR offline_window_days BETWEEN 1 AND 30),
    debt_ceiling_rial       bigint CHECK (debt_ceiling_rial IS NULL OR debt_ceiling_rial >= 0),
    over_lease_price_bps    integer CHECK (over_lease_price_bps IS NULL OR over_lease_price_bps BETWEEN 1 AND 1000000),
    lock_policy             text CHECK (lock_policy IS NULL OR lock_policy IN ('block', 'read_only')),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Class B meters: work the device itself executes, settled after the fact.
-- Class A (cloud-executed) and class C (time/volume) meters stay in
-- billing_meters and never appear here.
CREATE TABLE credit_offline_meters (
    meter_key       text PRIMARY KEY CHECK (meter_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
    name            text NOT NULL CHECK (length(trim(name)) > 0),
    description     text NOT NULL DEFAULT '',
    unit            text NOT NULL,
    -- Which deployment profiles run it locally: hybrid and/or local (Full Offline).
    installs        text[] NOT NULL
                        CHECK (cardinality(installs) > 0 AND installs <@ ARRAY['hybrid', 'local']::text[]),
    -- off: not metered. shadow: metered and rated, nothing enforced.
    -- enforced: lease, debt and lock apply.
    mode            text NOT NULL DEFAULT 'shadow'
                        CHECK (mode IN ('off', 'shadow', 'enforced')),
    sort_order      integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO credit_offline_meters (meter_key, name, description, unit, installs, mode, sort_order)
VALUES
    ('pos.sale_closed', 'سفارش بسته‌شده',
     'یک سفارش یا فاکتور خرده‌فروشی که به وضعیت نهایی تسویه‌شده می‌رسد.',
     'order', ARRAY['hybrid', 'local'], 'shadow', 10),
    ('ledger.payroll_run_posted', 'ثبت اجرای حقوق',
     'یک اجرای حقوق که در دفتر ثبت می‌شود.',
     'run', ARRAY['local'], 'shadow', 20),
    ('stock.count_posted', 'ثبت انبارگردانی',
     'یک شمارش فیزیکی موجودی که ثبت می‌شود.',
     'count', ARRAY['local'], 'shadow', 30)
ON CONFLICT (meter_key) DO NOTHING;
