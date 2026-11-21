-- ============================================================================
-- 0309_commercial_resolver.sql — ESH-193 / #1378 stage 4.
--
-- The canonical resolver's *data* half. It adds exactly the facts the pure
-- resolver in `src/lib/billing/resolver/` needs and nothing that replaces an
-- existing table:
--
--   1. `billing_policy_versions` — the deployment's commercial policy versions.
--      Version 0 is implicit ("legacy") and has no row: a business with no
--      enrolment prices exactly as it did before this migration.
--   2. `business_commercial_policies` — a tenant's explicit opt-in to one
--      version. No row = legacy/grandfathered, which is what keeps existing
--      customer terms unchanged absent a reviewed migration.
--   3. `billing_plan_benefits` — the one place an approved plan inclusion,
--      service discount or provider-cost policy is written, keyed on the stable
--      `benefit_id` identity (never a display label). A row is inert until
--      `approved`.
--   4. `service_term_offers` — a published 1/3/12-month prepaid *service* offer
--      per service identity. Published-only and versioned, so an unpriced term
--      cannot be sold.
--   5. `business_service_terms` — the purchased prepaid service interval. While
--      it covers an instant, enabled-time rental for that service is not
--      charged again; setup and metered usage stay separate.
--
-- Deliberate boundaries:
--  * `setup_once`, `enabled_time`, `metered_usage`, allowances and provider
--    costs keep their existing identities, prices and settlement paths (#1041,
--    #902). This migration adds no second price catalogue: a benefit row names
--    the existing service/meter and the existing published version.
--  * Amounts on offers are immutable; a price change is a new version.
--  * Tenant tables carry forced RLS with the standard policy.
--
-- Rollback: additive. Dropping the two tenant tables, the two catalogues and
-- the three columns restores 0308 (the wallet `service_term` kind is removed
-- from the CHECK by the same statement).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Commercial policy versions (global catalogue)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_policy_versions (
    version        integer PRIMARY KEY CHECK (version > 0),
    status         text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'active', 'retired')),
    effective_from timestamptz NOT NULL DEFAULT now(),
    note           text NOT NULL DEFAULT '',
    -- The policy as published: discount rates, allowance rules and any explicit
    -- permissions (for example "an included service may still charge its
    -- tariff"). Snapshotted so a later policy edit cannot rewrite history.
    snapshot       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by     uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE billing_policy_versions IS
    'Deployment commercial policy versions (ESH-193). Version 0 is implicit legacy; a tenant applies a version only by enrolling in business_commercial_policies.';

-- ---------------------------------------------------------------------------
-- 2. Tenant enrolment — the opt-in boundary
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_commercial_policies (
    business_id    uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    policy_version integer NOT NULL REFERENCES billing_policy_versions(version) ON DELETE RESTRICT,
    enrolled_at    timestamptz NOT NULL DEFAULT now(),
    enrolled_by    uuid REFERENCES platform_users(id) ON DELETE SET NULL,
    note           text NOT NULL DEFAULT '',
    CHECK (policy_version > 0)
);

COMMENT ON TABLE business_commercial_policies IS
    'A tenant explicitly enrolled in a reviewed commercial policy version. Absence of a row means legacy terms, preserved unchanged (ESH-193).';

-- ---------------------------------------------------------------------------
-- 3. Plan benefits (global, per plan)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_plan_benefits (
    plan_key       text NOT NULL REFERENCES billing_plans(key) ON DELETE CASCADE,
    -- The stable benefit identity from `billing/resolver/identities.ts`, e.g.
    -- `service:app:accounting/setup_once@services.activation` or
    -- `meter:ai.credit/metered_usage@ai.chat`. Never a display label.
    benefit_id     text NOT NULL CHECK (length(btrim(benefit_id)) BETWEEN 5 AND 300),
    benefit_kind   text NOT NULL CHECK (benefit_kind IN (
                       'access', 'setup_once', 'enabled_time',
                       'metered_usage', 'allowance_overage', 'provider_cost')),
    capability_key text NOT NULL CHECK (length(btrim(capability_key)) > 0),
    service_kind   text CHECK (service_kind IS NULL OR service_kind IN ('app', 'workspace', 'agent')),
    service_key    text,
    meter_key      text,
    inclusion      text NOT NULL DEFAULT 'uncovered'
                       CHECK (inclusion IN ('included', 'discounted', 'uncovered')),
    discount_basis_points integer NOT NULL DEFAULT 0
                       CHECK (discount_basis_points BETWEEN 0 AND 10000),
    -- Explicit written policy only: an included service still charges its
    -- published tariff. Default false — inclusion is the whole benefit.
    charges_tariff_when_included boolean NOT NULL DEFAULT false,
    provider_cost_policy text
                       CHECK (provider_cost_policy IS NULL
                              OR provider_cost_policy IN ('pass_through', 'absorbed')),
    -- An unapproved row is inert: the published tariff is charged instead.
    approved       boolean NOT NULL DEFAULT false,
    -- 0 = applies to legacy tenants; N applies only to tenants enrolled in
    -- policy version >= N. New policy never reaches a legacy tenant silently.
    policy_version integer NOT NULL DEFAULT 0 CHECK (policy_version >= 0),
    updated_by     uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (plan_key, benefit_id),
    CHECK ((service_kind IS NULL) = (service_key IS NULL)),
    CHECK (service_key IS NULL OR length(btrim(service_key)) > 0),
    CHECK (meter_key IS NULL OR length(btrim(meter_key)) > 0),
    CHECK (inclusion <> 'discounted' OR discount_basis_points > 0),
    CHECK (inclusion = 'discounted' OR discount_basis_points = 0),
    CHECK (provider_cost_policy IS NULL OR benefit_kind = 'provider_cost')
);

COMMENT ON TABLE billing_plan_benefits IS
    'Approved plan inclusions/discounts keyed by stable benefit identity (ESH-193). policy_version 0 applies to legacy tenants; higher versions apply only to explicitly enrolled tenants.';

-- ---------------------------------------------------------------------------
-- 4. Prepaid service term offers (global, versioned, published-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_term_offers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service_kind    text NOT NULL CHECK (service_kind IN ('app', 'workspace', 'agent')),
    service_key     text NOT NULL CHECK (length(btrim(service_key)) > 0),
    term_months     integer NOT NULL CHECK (term_months IN (1, 3, 12)),
    version         integer NOT NULL CHECK (version > 0),
    currency        text NOT NULL DEFAULT 'IRR' CHECK (currency = 'IRR'),
    price_rial      bigint NOT NULL CHECK (price_rial >= 0),
    -- Same fail-closed rule as service_price_schedules: no published offer means
    -- the term may not be sold. A free term is an explicit published 0.
    published       boolean NOT NULL DEFAULT false,
    effective_from  timestamptz NOT NULL DEFAULT now(),
    effective_until timestamptz,
    note            text,
    created_by      uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (service_kind, service_key, term_months, version),
    CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_term_offers_open
    ON service_term_offers (service_kind, service_key, term_months)
    WHERE effective_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_service_term_offers_history
    ON service_term_offers (service_kind, service_key, term_months, effective_from DESC);

CREATE OR REPLACE FUNCTION service_term_offers_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.service_kind IS DISTINCT FROM OLD.service_kind
       OR NEW.service_key IS DISTINCT FROM OLD.service_key
       OR NEW.term_months IS DISTINCT FROM OLD.term_months
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.price_rial IS DISTINCT FROM OLD.price_rial
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
        RAISE EXCEPTION 'service term offers are immutable; publish a new version';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_term_offers_no_rewrite ON service_term_offers;
CREATE TRIGGER service_term_offers_no_rewrite
    BEFORE UPDATE ON service_term_offers
    FOR EACH ROW EXECUTE FUNCTION service_term_offers_immutable();

COMMENT ON TABLE service_term_offers IS
    'Published 1/3/12-month prepaid service offers (ESH-193). A term is sellable only from a published version; amounts are immutable.';

-- ---------------------------------------------------------------------------
-- 5. Tenant prepaid service terms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_service_terms (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    activation_id  uuid NOT NULL REFERENCES business_service_activations(id) ON DELETE CASCADE,
    service_kind   text NOT NULL CHECK (service_kind IN ('app', 'workspace', 'agent')),
    service_key    text NOT NULL CHECK (length(btrim(service_key)) > 0),
    term_months    integer NOT NULL CHECK (term_months IN (1, 3, 12)),
    offer_id       uuid NOT NULL REFERENCES service_term_offers(id) ON DELETE RESTRICT,
    price_rial     bigint NOT NULL CHECK (price_rial >= 0),
    price_version  integer NOT NULL CHECK (price_version > 0),
    policy_version integer NOT NULL DEFAULT 0 CHECK (policy_version >= 0),
    period_start   timestamptz NOT NULL,
    period_end     timestamptz NOT NULL,
    status         text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'expired', 'cancelled')),
    -- Service-term auto-renew is explicit opt-in, exactly like a plan's.
    auto_renew     boolean NOT NULL DEFAULT false,
    wallet_ledger_id uuid,
    purchased_by   uuid REFERENCES platform_users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (period_end > period_start)
);

-- One term per activation per start instant, so a replayed purchase cannot
-- create a second paid interval. Overlap across different starts is refused in
-- the purchase transaction, which holds the activation row lock.
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_service_terms_one_start
    ON business_service_terms (activation_id, period_start);
CREATE INDEX IF NOT EXISTS idx_business_service_terms_active
    ON business_service_terms (business_id, activation_id, period_end)
 WHERE status = 'active';

COMMENT ON TABLE business_service_terms IS
    'Purchased prepaid service intervals (ESH-193). Enabled-time rental is suppressed while one covers the instant; monthly allowances still reset each calendar month.';

-- ---------------------------------------------------------------------------
-- 6. Wallet ledger: the prepaid-term debit is its own kind
-- ---------------------------------------------------------------------------
ALTER TABLE wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_kind_check;
ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_kind_check CHECK (kind IN (
    'top_up', 'payment', 'admin_grant', 'refund',
    'feature_charge', 'addon_purchase', 'plan_fee',
    'subscription', 'admin_adjust', 'free_promo',
    'service_setup', 'service_runtime', 'service_term'
));

-- ---------------------------------------------------------------------------
-- 7. RLS for the tenant halves
-- ---------------------------------------------------------------------------
ALTER TABLE business_commercial_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_commercial_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON business_commercial_policies;
CREATE POLICY tenant_isolation ON business_commercial_policies FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE business_service_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_service_terms FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON business_service_terms;
CREATE POLICY tenant_isolation ON business_service_terms FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
