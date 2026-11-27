-- ============================================================================
-- 0322_signup_app_complimentary_grants.sql — GitHub #1579 / ESH-226.
--
-- Superadmin-controlled signup offers: an app may be offered as standard paid,
-- free for N days, free indefinitely, or not selectable. A complimentary grant
-- waives the once-only setup fee and the enabled-time rental for its covered
-- interval; separately metered consumption (AI tokens, SMS, provider costs) is
-- untouched.
--
-- Why these two tables rather than extending an existing one:
--   * `billing_plan_benefits` (0309) is a *plan* inclusion keyed on plan_key —
--     it cannot express "free for 30 days for cafés only", nor a per-business
--     exception, nor a revocable interval with its own clock.
--   * `service_term_offers` / `business_service_terms` (0309) are *purchased*
--     prepaid terms: they require a published price and a wallet debit. A
--     complimentary grant is not a purchase and must never debit.
--   * `business_service_activations` (0255) is the runtime state machine, and
--     this migration deliberately does NOT add a competing one: a grant is
--     commercial *coverage* that the canonical resolver reads, while the
--     activation row still owns active/suspended/disabled/purge semantics.
--
-- Precedence encoded here (resolved in `src/lib/complimentary-grants.ts`):
--   business-specific override > business-type policy > global signup default
--   > ordinary published commercial pricing.
-- Technical availability (industry / deployment / platform availability) is
-- NEVER overridable by a grant — it is checked before any commercial decision.
--
-- Money is integer Rial. Timestamps are exact UTC instants; a grant starting at
-- 10:00Z for 30 days ends at 10:00Z on day 30, never at a rounded midnight.
--
-- Rollback: additive. Truncating then dropping `business_complimentary_grants`
-- and `signup_app_policies` restores the 0321 schema. No existing row, invoice,
-- price version, activation or wallet entry is read or rewritten by this
-- migration, so a rollback cannot corrupt historical financial evidence.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Signup app policy revisions (global catalogue, no tenant scope)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signup_app_policies (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service_kind    text NOT NULL CHECK (service_kind IN ('app', 'workspace', 'agent')),
    service_key     text NOT NULL,
    -- A revision number per (service, scope target), so an edit appends a new
    -- version instead of rewriting the offer an already-active grant was made
    -- under. `version` is monotonically increasing and never reused.
    version         integer NOT NULL CHECK (version > 0),
    scope           text NOT NULL CHECK (scope IN ('global', 'business_type', 'business')),
    business_type   text,
    business_id     uuid REFERENCES businesses(id) ON DELETE CASCADE,
    mode            text NOT NULL
                        CHECK (mode IN ('standard', 'free_days', 'free_indefinite', 'not_selectable')),
    free_days       integer,
    waive_setup     boolean NOT NULL DEFAULT true,
    waive_rental    boolean NOT NULL DEFAULT true,
    status          text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('draft', 'active', 'retired')),
    effective_from  timestamptz NOT NULL DEFAULT now(),
    effective_until timestamptz,
    reason          text NOT NULL DEFAULT '',
    created_by      uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- A scope carries exactly the target it names. A business-type policy must
    -- not silently also be a business override.
    CONSTRAINT signup_app_policies_scope_shape CHECK (
        (scope = 'global' AND business_type IS NULL AND business_id IS NULL)
        OR (scope = 'business_type' AND business_type IS NOT NULL AND business_id IS NULL)
        OR (scope = 'business' AND business_id IS NOT NULL AND business_type IS NULL)
    ),
    -- A duration policy has a positive day count; every other mode has none.
    -- A zero/negative "free for N days" must be rejected at the database, not
    -- only in the API, because it would otherwise grant zero-length coverage.
    CONSTRAINT signup_app_policies_free_days_shape CHECK (
        (mode = 'free_days' AND free_days IS NOT NULL AND free_days > 0 AND free_days <= 3650)
        OR (mode <> 'free_days' AND free_days IS NULL)
    ),
    CONSTRAINT signup_app_policies_effective_window CHECK (
        effective_until IS NULL OR effective_until > effective_from
    )
);

COMMENT ON TABLE signup_app_policies IS
    'Superadmin signup app offer revisions (GitHub #1579). Append-only: an edit writes a new version and retires the previous open revision. Existing grants keep the policy_id/version they were made under.';

-- Exactly one open (in-force) revision per service and scope target. Two
-- simultaneous "global accounting = free" rows would make precedence
-- non-deterministic, which is the one thing this feature must never be.
CREATE UNIQUE INDEX IF NOT EXISTS signup_app_policies_one_open_target
    ON signup_app_policies (
        service_kind,
        service_key,
        scope,
        COALESCE(business_type, ''),
        COALESCE(business_id::text, '')
    )
    WHERE status = 'active' AND effective_until IS NULL;

CREATE INDEX IF NOT EXISTS signup_app_policies_lookup
    ON signup_app_policies (service_kind, service_key, status, business_type);

-- ---------------------------------------------------------------------------
-- 2. Complimentary grants (tenant-scoped)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_complimentary_grants (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    service_kind       text NOT NULL CHECK (service_kind IN ('app', 'workspace', 'agent')),
    service_key        text NOT NULL,
    runtime_instance_id text NOT NULL DEFAULT '',
    -- The policy revision the grant was issued under. SET NULL keeps the grant
    -- (and its financial evidence) if a catalogue row is ever removed.
    policy_id          uuid REFERENCES signup_app_policies(id) ON DELETE SET NULL,
    policy_version     integer,
    source             text NOT NULL CHECK (source IN ('signup_policy', 'manual')),
    scope              text NOT NULL CHECK (scope IN ('global', 'business_type', 'business')),
    status             text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('pending', 'active', 'expired', 'revoked')),
    starts_at          timestamptz NOT NULL,
    -- NULL = indefinite, until an authorized revocation or a lawful commercial
    -- change. Never derived from a missing date at read time.
    expires_at         timestamptz,
    waive_setup        boolean NOT NULL DEFAULT true,
    waive_rental       boolean NOT NULL DEFAULT true,
    activation_id      uuid REFERENCES business_service_activations(id) ON DELETE SET NULL,
    actor              text,
    reason             text NOT NULL DEFAULT '',
    revoked_at         timestamptz,
    revoked_by         text,
    revoke_reason      text,
    extended_at        timestamptz,
    extended_by        text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT business_complimentary_grants_window CHECK (
        expires_at IS NULL OR expires_at > starts_at
    ),
    CONSTRAINT business_complimentary_grants_revoked_shape CHECK (
        (status = 'revoked' AND revoked_at IS NOT NULL)
        OR (status <> 'revoked')
    )
);

COMMENT ON TABLE business_complimentary_grants IS
    'Tenant-scoped complimentary app/service coverage (GitHub #1579). The canonical resolver reads it as setup waiver + enabled-time coverage; it debits no wallet and never starts a paid subscription.';

-- One effective active grant per service identity and tenant: overlapping
-- active grants would double-waive and could be extended from two tabs.
CREATE UNIQUE INDEX IF NOT EXISTS business_complimentary_grants_one_active
    ON business_complimentary_grants (business_id, service_kind, service_key, runtime_instance_id)
    WHERE status = 'active';

-- A single activation yields at most one grant, so a retried activation cannot
-- issue a second free period.
CREATE UNIQUE INDEX IF NOT EXISTS business_complimentary_grants_one_per_activation
    ON business_complimentary_grants (activation_id)
    WHERE activation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS business_complimentary_grants_expiry
    ON business_complimentary_grants (status, expires_at)
    WHERE status = 'active' AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS business_complimentary_grants_business
    ON business_complimentary_grants (business_id, service_kind, service_key);

-- ---------------------------------------------------------------------------
-- 3. Tenant isolation (forced RLS, same policy shape as the rest of the schema)
-- ---------------------------------------------------------------------------
-- The policy catalogue is platform-owned, but a `business`-scope revision names
-- a tenant, so it carries `business_id` and must not become an RLS outlier: any
-- table with a tenant column gets the one approved policy. Global and
-- business-type revisions have no `business_id` and are therefore visible only
-- under the documented platform bypass, which is exactly how every read and
-- write in `src/lib/complimentary-grant-service.ts` reaches the catalogue — a
-- client-scoped connection can never read or forge another business's override.
ALTER TABLE signup_app_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE signup_app_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON signup_app_policies FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE business_complimentary_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_complimentary_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_complimentary_grants FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
