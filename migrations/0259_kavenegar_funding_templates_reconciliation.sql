-- Issue #902 — managed SMS, part two: funding policy, lookup templates and
-- reconciliation.
--
-- `0258` created the account, credential, queue and internal credit journal.
-- This migration adds the three things that make those rows OPERABLE without
-- inventing a second commercial domain:
--
--   * **funding policy** — how much wholesale credit a child should carry, and
--     the caps that stop an automation bug from emptying the master account;
--   * **lookup templates** — the approved verification/transactional messages
--     a tenant can use, with first-party titles and a provider-neutral state;
--   * **reconciliation runs** — periodic evidence that what the provider says
--     the child holds equals what our own journal says it should hold, plus the
--     wholesale cost vs. the retail amount already charged to the tenant's
--     single wallet.
--
-- Nothing here is a tenant balance. Retail money stays in `wallet_ledger` /
-- `billing_*`; provider credit stays an internal pre-funding artifact.

-- ---------------------------------------------------------------------------
-- What the provider last told us about a child
-- ---------------------------------------------------------------------------

-- `client/fetch`/`client/list` report `remaincredit`. Storing it is what makes
-- both JIT funding (how much is missing) and reconciliation (is our journal
-- right) possible without calling the provider from a request path.
ALTER TABLE kavenegar_business_accounts
    ADD COLUMN provider_balance_rial bigint
        CHECK (provider_balance_rial IS NULL OR provider_balance_rial >= 0),
    ADD COLUMN provider_balance_at timestamptz;

-- ---------------------------------------------------------------------------
-- Funding policy (Superadmin, on the existing platform singleton)
-- ---------------------------------------------------------------------------

-- Zero buffer messages means automatic top-up is OFF: rows still provision, and
-- funding stays an explicit console action. That is the safe default — moving
-- the platform's money must be turned on deliberately, after the drills in
-- docs/integrations/kavenegar-managed-service.md.
ALTER TABLE platform_sms_config
    ADD COLUMN managed_funding_buffer_messages integer NOT NULL DEFAULT 0
        CHECK (managed_funding_buffer_messages BETWEEN 0 AND 1_000_000),
    -- Absolute ceiling a single child may hold. NULL = no per-child ceiling
    -- (the daily cap and the master floor still apply).
    ADD COLUMN managed_funding_child_cap_rial bigint
        CHECK (managed_funding_child_cap_rial IS NULL OR managed_funding_child_cap_rial > 0),
    -- Maximum a child may receive in one rolling day. NULL = no daily cap.
    ADD COLUMN managed_funding_daily_cap_rial bigint
        CHECK (managed_funding_daily_cap_rial IS NULL OR managed_funding_daily_cap_rial > 0),
    -- Wholesale credit the master account must keep for OTHER children and for
    -- its own OTP traffic. Never fund a child below this line.
    ADD COLUMN managed_funding_master_floor_rial bigint NOT NULL DEFAULT 0
        CHECK (managed_funding_master_floor_rial >= 0);

-- ---------------------------------------------------------------------------
-- Lookup template catalog
-- ---------------------------------------------------------------------------

CREATE TABLE kavenegar_lookup_templates (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id          uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Provider template name. ASCII, no spaces, unique inside the child
    -- account. Derived once at creation (`bm<8 hex>`) so the operator never
    -- has to invent one and a retry is recognisable.
    name                 text NOT NULL,
    -- What the TENANT calls this message ("کد ورود", «یادآوری نوبت»). The
    -- provider only ever sees `name` and `body`.
    title                text NOT NULL,
    body                 text NOT NULL,
    purpose              text NOT NULL DEFAULT 'verification'
        CHECK (purpose IN ('verification', 'transactional')),
    -- draft → submitted → approved | rejected; disabled stops automation.
    state                text NOT NULL DEFAULT 'draft'
        CHECK (state IN ('draft', 'submitted', 'approved', 'rejected', 'disabled')),
    provider_template_id bigint,
    -- Provider-neutral sync failure code. Provider text is never stored here:
    -- it is not actionable for a tenant and may contain supplier vocabulary.
    last_sync_error      text,
    submitted_at         timestamptz,
    decided_at           timestamptz,
    last_synced_at       timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT kavenegar_lookup_templates_name_per_business UNIQUE (business_id, name),
    CONSTRAINT kavenegar_lookup_templates_token CHECK (strpos(body, '%token') > 0),
    CONSTRAINT kavenegar_lookup_templates_name_format CHECK (name ~ '^[A-Za-z][A-Za-z0-9]{3,39}$'),
    CONSTRAINT kavenegar_lookup_templates_title CHECK (length(btrim(title)) BETWEEN 1 AND 80)
);

CREATE INDEX kavenegar_lookup_templates_business
    ON kavenegar_lookup_templates (business_id, state);

ALTER TABLE kavenegar_lookup_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE kavenegar_lookup_templates FORCE ROW LEVEL SECURITY;
-- Tenant-scoped: a business may read its own catalog (it is shown as Bizamiz's
-- own message library), and only services write it.
CREATE POLICY tenant_isolation ON kavenegar_lookup_templates FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Reconciliation runs
-- ---------------------------------------------------------------------------

CREATE TABLE kavenegar_reconciliation_runs (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    account_id              uuid REFERENCES kavenegar_business_accounts(id) ON DELETE SET NULL,
    -- The half-open window [window_start, window_end). `window_end` is aligned
    -- to the hour so a retried pass cannot create a second run for the same
    -- period.
    window_start            timestamptz NOT NULL,
    window_end              timestamptz NOT NULL,
    -- Evidence, wholesale Rial only.
    provider_balance_rial   bigint,
    expected_balance_rial   bigint,
    delta_rial              bigint,
    credit_transferred_rial bigint NOT NULL DEFAULT 0,
    provider_cost_rial      bigint NOT NULL DEFAULT 0,
    retail_charged_rial     bigint NOT NULL DEFAULT 0,
    state                   text NOT NULL
        CHECK (state IN ('ok', 'drift', 'incomplete')),
    -- Small, provider-neutral details (counts, tolerance used). Never a raw
    -- provider payload.
    detail                  jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT kavenegar_reconciliation_runs_window UNIQUE (business_id, window_end)
);

CREATE INDEX kavenegar_reconciliation_runs_recent
    ON kavenegar_reconciliation_runs (created_at DESC, state);

ALTER TABLE kavenegar_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE kavenegar_reconciliation_runs FORCE ROW LEVEL SECURITY;
-- Tenant-scoped for the same reason as the job queue and the credit journal:
-- the sweeps read under the platform bypass, and a scoped query stays inside one
-- business. No tenant surface reads these runs.
CREATE POLICY tenant_isolation ON kavenegar_reconciliation_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE kavenegar_reconciliation_runs IS
    'Issue #902: wholesale balance/usage evidence. Not a tenant balance; never exposed to tenants.';
COMMENT ON COLUMN kavenegar_business_accounts.provider_balance_rial IS
    'Last provider-reported remaincredit (wholesale, internal). Used by JIT funding and reconciliation.';
