-- ============================================================================
-- 0255_service_activation_billing.sql — issue #1041.
--
-- The Service Activation & Runtime Billing layer: one *new* charge on the
-- business's existing wallet for (a) the first successful setup of a service
-- and (b) every hour that service stays enabled, plus the per-service
-- retention/destruction policy that starts counting down after a deliberate
-- customer disable.
--
-- Nothing here replaces an existing billing system. Subscriptions, top-ups,
-- add-ons, payments, invoices and AI token credits keep their tables, routes
-- and contracts; this migration only adds:
--
--   service_price_schedules            per-service setup/hourly tariff, versioned
--                                      (global catalogue — no business_id)
--   business_service_activations       one row per business + stable identity
--   service_activation_intervals       the canonical enabled-time intervals
--   service_runtime_charges            settled hourly segments (idempotent)
--   service_setup_charges              the once-per-identity setup evidence
--   business_service_wizard_state      the app's own resumable setup data
--   service_activation_events          the tenant-visible lifecycle audit trail
--   service_retention_policies         Superadmin policy per service (global)
--   business_service_retention_overrides  audited per-business override
--   service_purge_queue                the scheduled destruction queue
--   service_purge_journal              the append-only deletion journal
--
-- and two meters (`service.setup`, `service.enabled_seconds`), so enabled-time
-- and setup charges appear in the canonical usage ledger / rollups the billing
-- console already reads.
--
-- Deliberate design notes
-- -----------------------
-- * Every price row is IMMUTABLE once written; a price change is a new version.
--   A settled interval keeps the price version it was settled at, so history
--   never moves under a business.
-- * There is NO default price. A service with no *published* schedule is not
--   eligible to activate ("fail closed") — free is an explicit published 0 Rial
--   row, never the absence of one.
-- * Enabled time is measured in whole seconds and billed per second, rounded up
--   to the Rial once per settlement segment. A segment's `(interval_id,
--   period_start)` is unique and its usage event id is deterministic, so a
--   restarted or concurrent worker cannot bill the same second twice.
-- * A customer disable is the ONLY thing that can start a retention countdown.
--   Suspension (credit, maintenance, provider outage, legal hold) is a separate
--   state with a separate reason and never schedules a purge.
-- * The purge tables delete service-owned data only. Wallet, ledger, invoices,
--   usage, setup-paid evidence and the activation row itself are protected;
--   datasets whose ownership has not been reviewed are recorded as blocked
--   ("partial"), never silently dropped.
--
-- App boundary: `service_kind='app'` uses the four keys of src/lib/apps.ts;
-- `workspace` means a separately priced My Workspace business capability (the
-- shell itself is never sold or hidden); `agent` means a Superadmin-published
-- background agent/routine. The AI chat home is NOT a service here — it keeps
-- its token/credit meter.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Per-service tariff (global catalogue, like app_availability: deployment-wide,
-- no business_id, owned by the super-admin console).
-- ---------------------------------------------------------------------------
CREATE TABLE service_price_schedules (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service_kind            text NOT NULL
                              CHECK (service_kind IN ('app', 'workspace', 'agent')),
    service_key             text NOT NULL CHECK (length(btrim(service_key)) > 0),
    version                 integer NOT NULL CHECK (version > 0),
    currency                text NOT NULL DEFAULT 'IRR' CHECK (currency = 'IRR'),
    -- 'fixed' = a Rial amount; 'hour_equivalent' = N hours at this row's
    -- hourly rate. The equivalent hours are a *one-time setup fee equivalent*,
    -- never pre-paid runtime hours.
    setup_mode              text NOT NULL
                              CHECK (setup_mode IN ('fixed', 'hour_equivalent')),
    setup_fixed_rial        bigint NOT NULL DEFAULT 0 CHECK (setup_fixed_rial >= 0),
    setup_equivalent_hours  numeric(8, 2) NOT NULL DEFAULT 0
                              CHECK (setup_equivalent_hours >= 0),
    hourly_rate_rial        bigint NOT NULL DEFAULT 0 CHECK (hourly_rate_rial >= 0),
    -- Published = the tariff is in force. An unpriced (or draft) service stays
    -- ineligible; this is the "fail closed" half of issue #1041 §A.
    published               boolean NOT NULL DEFAULT false,
    effective_from          timestamptz NOT NULL DEFAULT now(),
    effective_until         timestamptz,
    note                    text,
    created_by              uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (service_kind, service_key, version),
    CHECK (effective_until IS NULL OR effective_until > effective_from),
    CHECK (setup_mode <> 'fixed' OR setup_equivalent_hours = 0),
    CHECK (setup_mode <> 'hour_equivalent' OR setup_fixed_rial = 0)
);

-- One open version per service identity: a new price closes the previous row.
CREATE UNIQUE INDEX idx_service_price_schedules_open
    ON service_price_schedules (service_kind, service_key)
    WHERE effective_until IS NULL;

CREATE INDEX idx_service_price_schedules_history
    ON service_price_schedules (service_kind, service_key, effective_from DESC);

-- A price version is a historical fact. Only the closing timestamp and the
-- publication flag may change afterwards; the money never does.
CREATE OR REPLACE FUNCTION service_price_schedules_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.service_kind IS DISTINCT FROM OLD.service_kind
       OR NEW.service_key IS DISTINCT FROM OLD.service_key
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.setup_mode IS DISTINCT FROM OLD.setup_mode
       OR NEW.setup_fixed_rial IS DISTINCT FROM OLD.setup_fixed_rial
       OR NEW.setup_equivalent_hours IS DISTINCT FROM OLD.setup_equivalent_hours
       OR NEW.hourly_rate_rial IS DISTINCT FROM OLD.hourly_rate_rial
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
        RAISE EXCEPTION 'service price versions are immutable; publish a new version';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER service_price_schedules_no_rewrite
    BEFORE UPDATE ON service_price_schedules
    FOR EACH ROW EXECUTE FUNCTION service_price_schedules_immutable();

-- ---------------------------------------------------------------------------
-- Retention policy — global half. No row means "keep everything, purge
-- nothing": the safe default a new service starts from.
-- ---------------------------------------------------------------------------
CREATE TABLE service_retention_policies (
    service_kind          text NOT NULL
                            CHECK (service_kind IN ('app', 'workspace', 'agent')),
    service_key           text NOT NULL CHECK (length(btrim(service_key)) > 0),
    -- false = no automatic destruction at all (the explicit "indefinite"
    -- choice), and then retention_days must be NULL.
    auto_purge_enabled    boolean NOT NULL DEFAULT false,
    retention_days        integer
                            CHECK (retention_days IS NULL OR (retention_days >= 1 AND retention_days <= 3650)),
    notification_lead_days integer NOT NULL DEFAULT 7 CHECK (notification_lead_days >= 0),
    export_grace_days     integer NOT NULL DEFAULT 7 CHECK (export_grace_days >= 0),
    policy_version        integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
    note                  text,
    updated_by            uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (service_kind, service_key),
    CHECK (NOT auto_purge_enabled OR retention_days IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Tenant tables
-- ---------------------------------------------------------------------------

-- One row per business + stable service identity. `runtime_instance_id`
-- distinguishes billable runtime instances of the same published agent; it is
-- ''.' for apps, workspace capabilities and per-agent singletons.
CREATE TABLE business_service_activations (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    service_kind          text NOT NULL
                            CHECK (service_kind IN ('app', 'workspace', 'agent')),
    service_key           text NOT NULL CHECK (length(btrim(service_key)) > 0),
    runtime_instance_id   text NOT NULL DEFAULT '',
    label                 text NOT NULL DEFAULT '',
    -- issue #1041 §B. Suspension states are deliberately NOT
    -- `disabled_retained`: only a customer disable may start retention.
    state                 text NOT NULL DEFAULT 'setup_in_progress'
                            CHECK (state IN (
                              'setup_in_progress', 'payment_reserved', 'active',
                              'disabled_retained', 'eligible_for_purge', 'purging',
                              'data_purged', 'suspended_insufficient_credit',
                              'platform_unavailable', 'legal_hold', 'purge_failed'
                            )),
    -- The setup fee is charged once per business per stable identity and this
    -- flag (plus service_setup_charges) is the commercial evidence that
    -- survives disable, suspension and purge.
    setup_paid            boolean NOT NULL DEFAULT false,
    setup_paid_at         timestamptz,
    setup_amount_rial     bigint CHECK (setup_amount_rial IS NULL OR setup_amount_rial >= 0),
    setup_price_version   integer,
    -- The immutable quote the customer consented to, exactly as shown.
    setup_quote           jsonb NOT NULL DEFAULT '{}'::jsonb,
    provisioned_at        timestamptz,
    activated_at          timestamptz,
    disabled_at           timestamptz,
    -- Why the customer-facing disable happened. Never set for a suspension.
    disabled_reason       text
                            CHECK (disabled_reason IS NULL OR disabled_reason IN ('customer', 'operator', 'dependency')),
    suspended_at          timestamptz,
    suspension_reason     text
                            CHECK (suspension_reason IS NULL OR suspension_reason IN (
                              'insufficient_credit', 'platform_unavailable',
                              'maintenance', 'legal_hold', 'trial_grace'
                            )),
    retention_deadline    timestamptz,
    purge_state           text NOT NULL DEFAULT 'none'
                            CHECK (purge_state IN (
                              'none', 'scheduled', 'cancelled', 'running',
                              'completed', 'partial', 'failed', 'blocked'
                            )),
    data_purged_at        timestamptz,
    -- The client's idempotency key for the activation request, kept for audit.
    activation_request_id text,
    last_settled_at       timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, service_kind, service_key, runtime_instance_id)
);

CREATE INDEX idx_business_service_activations_due_purge
    ON business_service_activations (retention_deadline)
    WHERE retention_deadline IS NOT NULL;
CREATE INDEX idx_business_service_activations_state
    ON business_service_activations (business_id, state);

-- The canonical enabled-time intervals. An interval is opened by an activation
-- or a re-enable and closed by a disable/suspension. `last_settled_at` is the
-- cursor: everything before it has been settled exactly once.
CREATE TABLE service_activation_intervals (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    activation_id         uuid NOT NULL REFERENCES business_service_activations(id) ON DELETE CASCADE,
    started_at            timestamptz NOT NULL,
    ended_at              timestamptz,
    last_settled_at       timestamptz,
    hourly_rate_rial      bigint NOT NULL CHECK (hourly_rate_rial >= 0),
    hourly_price_version  integer NOT NULL,
    -- The smallest segment worth a settlement pass. A shorter open segment
    -- simply waits; a closing interval settles every remaining second.
    minimum_unit_seconds  integer NOT NULL DEFAULT 60 CHECK (minimum_unit_seconds > 0),
    rounding              text NOT NULL DEFAULT 'ceil_second' CHECK (rounding = 'ceil_second'),
    trigger               text NOT NULL CHECK (trigger IN ('activation', 'reenable')),
    created_at            timestamptz NOT NULL DEFAULT now(),
    CHECK (ended_at IS NULL OR ended_at >= started_at),
    UNIQUE (activation_id, started_at)
);

-- At most one open interval per activation.
CREATE UNIQUE INDEX idx_service_activation_intervals_open
    ON service_activation_intervals (activation_id)
    WHERE ended_at IS NULL;

CREATE INDEX idx_service_activation_intervals_business
    ON service_activation_intervals (business_id, started_at DESC);
CREATE INDEX idx_service_activation_intervals_open_settlement
    ON service_activation_intervals (started_at)
    WHERE ended_at IS NULL;

-- One settled segment. `(interval_id, period_start)` is the idempotency key:
-- the same elapsed segment can never be charged twice, whatever the worker's
-- restart/concurrency story.
CREATE TABLE service_runtime_charges (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    activation_id         uuid NOT NULL REFERENCES business_service_activations(id) ON DELETE CASCADE,
    interval_id           uuid NOT NULL REFERENCES service_activation_intervals(id) ON DELETE CASCADE,
    period_start          timestamptz NOT NULL,
    period_end            timestamptz NOT NULL,
    billed_seconds        bigint NOT NULL CHECK (billed_seconds > 0),
    hourly_rate_rial      bigint NOT NULL CHECK (hourly_rate_rial >= 0),
    hourly_price_version  integer NOT NULL,
    amount_rial           bigint NOT NULL CHECK (amount_rial >= 0),
    wallet_ledger_id      uuid REFERENCES wallet_ledger(id) ON DELETE SET NULL,
    usage_event_id        uuid REFERENCES billing_usage_events(id) ON DELETE SET NULL,
    settled_at            timestamptz NOT NULL DEFAULT now(),
    metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (interval_id, period_start),
    CHECK (period_end > period_start)
);

CREATE INDEX idx_service_runtime_charges_business
    ON service_runtime_charges (business_id, settled_at DESC);
CREATE INDEX idx_service_runtime_charges_activation
    ON service_runtime_charges (activation_id, period_start);

-- The once-per-identity setup debit, kept as immutable commercial evidence.
-- Purge never deletes this row.
CREATE TABLE service_setup_charges (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    activation_id           uuid NOT NULL REFERENCES business_service_activations(id) ON DELETE CASCADE,
    service_kind            text NOT NULL,
    service_key             text NOT NULL,
    amount_rial             bigint NOT NULL CHECK (amount_rial >= 0),
    setup_mode              text NOT NULL CHECK (setup_mode IN ('fixed', 'hour_equivalent')),
    setup_equivalent_hours  numeric(8, 2) NOT NULL DEFAULT 0,
    hourly_rate_rial        bigint NOT NULL CHECK (hourly_rate_rial >= 0),
    price_version           integer NOT NULL,
    quote                   jsonb NOT NULL DEFAULT '{}'::jsonb,
    wallet_ledger_id        uuid REFERENCES wallet_ledger(id) ON DELETE SET NULL,
    usage_event_id          uuid REFERENCES billing_usage_events(id) ON DELETE SET NULL,
    charged_at              timestamptz NOT NULL DEFAULT now(),
    -- One setup charge per business + stable identity, enforced by the DB.
    UNIQUE (activation_id)
);

CREATE INDEX idx_service_setup_charges_business
    ON service_setup_charges (business_id, service_kind, service_key);

-- The app's own resumable setup wizard data. Genuinely service-owned
-- operational data: the purge worker deletes exactly these rows (and nothing
-- else) when a service's retention window expires.
CREATE TABLE business_service_wizard_state (
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    service_kind        text NOT NULL,
    service_key         text NOT NULL,
    runtime_instance_id text NOT NULL DEFAULT '',
    step                text NOT NULL DEFAULT 'draft',
    progress            jsonb NOT NULL DEFAULT '{}'::jsonb,
    version             integer NOT NULL DEFAULT 1 CHECK (version > 0),
    completed_at        timestamptz,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, service_kind, service_key, runtime_instance_id)
);

-- Tenant-visible lifecycle audit trail (activation, disable, re-enable,
-- suspension, settlements, purge steps).
CREATE TABLE service_activation_events (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    activation_id     uuid NOT NULL REFERENCES business_service_activations(id) ON DELETE CASCADE,
    service_kind      text NOT NULL,
    service_key       text NOT NULL,
    action            text NOT NULL CHECK (action IN (
                        'activated', 'activated_without_setup', 'setup_charged',
                        'disabled', 'reenabled', 'suspended', 'resumed',
                        'settled', 'wizard_saved',
                        'purge_scheduled', 'purge_cancelled', 'purge_started',
                        'purge_completed', 'purge_partial', 'purge_failed',
                        'held', 'released'
                      )),
    actor_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    platform_admin_id uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    amount_rial       bigint,
    detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_service_activation_events_activation
    ON service_activation_events (activation_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Retention: the audited per-business override and the destruction queue.
-- ---------------------------------------------------------------------------
CREATE TABLE business_service_retention_overrides (
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    service_kind       text NOT NULL,
    service_key        text NOT NULL,
    auto_purge_enabled boolean NOT NULL DEFAULT false,
    retention_days     integer
                         CHECK (retention_days IS NULL OR (retention_days >= 1 AND retention_days <= 3650)),
    policy_version     integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
    note               text,
    updated_by         uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, service_kind, service_key),
    CHECK (NOT auto_purge_enabled OR retention_days IS NOT NULL)
);

CREATE TABLE service_purge_queue (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    activation_id uuid NOT NULL REFERENCES business_service_activations(id) ON DELETE CASCADE,
    service_kind  text NOT NULL,
    service_key   text NOT NULL,
    scheduled_at  timestamptz NOT NULL,
    state         text NOT NULL DEFAULT 'scheduled'
                    CHECK (state IN ('scheduled', 'running', 'cancelled', 'completed', 'partial', 'failed', 'blocked')),
    policy_source text NOT NULL DEFAULT 'platform'
                    CHECK (policy_source IN ('platform', 'business')),
    policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
    attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (activation_id)
);

CREATE INDEX idx_service_purge_queue_due
    ON service_purge_queue (scheduled_at)
    WHERE state = 'scheduled';

CREATE TABLE service_purge_journal (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    activation_id uuid NOT NULL REFERENCES business_service_activations(id) ON DELETE CASCADE,
    queue_id      uuid REFERENCES service_purge_queue(id) ON DELETE SET NULL,
    dry_run       boolean NOT NULL DEFAULT false,
    status        text NOT NULL CHECK (status IN ('planned', 'completed', 'partial', 'failed', 'skipped', 'blocked')),
    scope         jsonb NOT NULL DEFAULT '[]'::jsonb,
    reclaimed     jsonb NOT NULL DEFAULT '{}'::jsonb,
    detail        text,
    started_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz
);

CREATE INDEX idx_service_purge_journal_activation
    ON service_purge_journal (activation_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- RLS for every tenant table (CLAUDE.md: a tenant-scoped table gets its policy
-- in the same migration).
-- ---------------------------------------------------------------------------
ALTER TABLE business_service_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_service_activations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON business_service_activations;
CREATE POLICY tenant_isolation ON business_service_activations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE service_activation_intervals ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_activation_intervals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON service_activation_intervals;
CREATE POLICY tenant_isolation ON service_activation_intervals FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE service_runtime_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_runtime_charges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON service_runtime_charges;
CREATE POLICY tenant_isolation ON service_runtime_charges FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE service_setup_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_setup_charges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON service_setup_charges;
CREATE POLICY tenant_isolation ON service_setup_charges FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE business_service_wizard_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_service_wizard_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON business_service_wizard_state;
CREATE POLICY tenant_isolation ON business_service_wizard_state FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE service_activation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_activation_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON service_activation_events;
CREATE POLICY tenant_isolation ON service_activation_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE business_service_retention_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_service_retention_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON business_service_retention_overrides;
CREATE POLICY tenant_isolation ON business_service_retention_overrides FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE service_purge_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_purge_queue FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON service_purge_queue;
CREATE POLICY tenant_isolation ON service_purge_queue FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE service_purge_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_purge_journal FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON service_purge_journal;
CREATE POLICY tenant_isolation ON service_purge_journal FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Two new wallet ledger kinds. The canonical wallet stays the ONE payment
-- authority; these are the service-specific statement lines issue #1041 asks
-- for, not a second balance.
-- ---------------------------------------------------------------------------
ALTER TABLE wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_kind_check;
ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_kind_check CHECK (kind IN (
    'top_up', 'payment', 'admin_grant', 'refund',
    'feature_charge', 'addon_purchase', 'plan_fee',
    'subscription', 'admin_adjust', 'free_promo',
    'service_setup', 'service_runtime'
));

-- ---------------------------------------------------------------------------
-- Declared meters. Enabled time is measured in seconds and is NOT CPU/RAM
-- consumption; setup is one activation event. Both are reported through the
-- existing billing usage ledger and daily rollups.
-- ---------------------------------------------------------------------------
INSERT INTO billing_meters
    (key, name, description, unit, aggregation, billing_period_behavior,
     customer_visible, billable, active, source, criticality)
VALUES
    ('service.setup', 'راه‌اندازی سرویس',
     'یک بار راه‌اندازی موفق سرویس؛ مبلغ آن در دفتر کیف پول ثبت می‌شود.',
     'activation', 'sum', 'reset', true, true, true, 'platform', 'noncritical'),
    ('service.enabled_seconds', 'زمان فعال بودن سرویس',
     'ثانیه‌های فعال بودن سرویس؛ مبنای هزینهٔ ساعتی دسترس‌پذیری است، نه مصرف پردازنده.',
     'second', 'duration', 'reset', true, true, true, 'platform', 'noncritical')
ON CONFLICT (key) DO NOTHING;
