-- Issue #902 — managed SMS at the provider's customer-management layer.
--
-- Bizamiz owns ONE provider master account and provisions one child account
-- per business inside it. That child account is an OPERATIONAL artifact of the
-- platform, not something a tenant can see, administer, fund or pay for:
--
--   * `kavenegar_business_accounts` is the tenant-scoped mapping (business UUID
--     <-> provider local id) plus the non-secret tariff/status metadata the
--     console reconciles. A tenant may read its own row; it must never be
--     serialised into a tenant response (see src/lib/managed-services/
--     contract.ts and its leak-guard test).
--   * `kavenegar_account_credentials` holds the CHILD API key, encrypted with
--     the platform realm secret, and is readable only under the platform
--     bypass. It has no tenant policy at all: the one legitimate tenant-side
--     reader is the outbox credential resolver, which reads it by an explicit
--     business id after the tenant is already established.
--   * `kavenegar_provisioning_jobs` is the durable, idempotent provisioning
--     queue. Workers and the console are its only readers.
--   * `kavenegar_credit_transfers` is the internal master -> child pre-funding
--     journal. Tenants have their own single wallet (migration 0177's
--     `wallet_ledger`); provider credit is invisible pre-funding and must never
--     become a second tenant balance.
--
-- No row here ever stores a plaintext credential, and nothing here replaces or
-- duplicates the central billing domain: retail prices, holds and invoices stay
-- in wallet/billing tables.

-- ---------------------------------------------------------------------------
-- Platform policy for managed child accounts
-- ---------------------------------------------------------------------------

-- Off by default. Provisioning against the provider's customer-management API
-- is only legal for master accounts the supplier has approved, so an install
-- must opt in from the console after the operator checklist in
-- docs/integrations/kavenegar-managed-service.md.
ALTER TABLE platform_sms_config
    ADD COLUMN managed_child_accounts_enabled boolean NOT NULL DEFAULT false,
    -- Provider `Planid` applied to every new child. NULL means "the master
    -- account's default tariff", which is what the provider does when the
    -- parameter is omitted.
    ADD COLUMN managed_plan_id integer CHECK (managed_plan_id IS NULL OR managed_plan_id > 0),
    -- Provider wholesale tariff floor a child must be able to charge itself.
    ADD COLUMN managed_min_allowed_credit_rial bigint NOT NULL DEFAULT 0
        CHECK (managed_min_allowed_credit_rial >= 0),
    -- Comma-separated provider line numbers assigned to children.
    ADD COLUMN managed_sender_lines text NOT NULL DEFAULT '',
    ADD COLUMN managed_policy_note text,
    ADD COLUMN managed_policy_updated_at timestamptz;

-- ---------------------------------------------------------------------------
-- One child account per business
-- ---------------------------------------------------------------------------

CREATE TABLE kavenegar_business_accounts (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The provider's `localid`. We always send the business UUID, so the
    -- mapping survives a lost response: `client/fetchbylocalid` is the recovery
    -- path that stops a timed-out create from becoming a second account.
    localid                 text NOT NULL CHECK (length(btrim(localid)) > 0),
    -- Provider panel username. Unique in the master account; a collision is
    -- provider status 502 and is resolved by retrying with a new username.
    username                text NOT NULL CHECK (length(btrim(username)) > 0),
    provision_state         text NOT NULL DEFAULT 'not_provisioned' CHECK (provision_state IN (
                                'not_provisioned',
                                'pending',
                                'provisioning',
                                'active',
                                'retry_pending',
                                'attention_required',
                                'suspended'
                            )),
    -- Why the state machine is where it is. Internal, provider-neutral codes
    -- (never a provider string): rendered to operators verbatim, and mapped to
    -- a first-party Persian sentence before any tenant ever sees it.
    attention_reason        text,
    -- Normalised provider status: Approved / PendingReview / Removed.
    provider_status         text CHECK (provider_status IN (
                                'approved', 'pending', 'removed', 'unknown'
                            )),
    -- Tariff snapshot the console reconciles against. Wholesale only.
    plan_id                 integer,
    pricing_name            text,
    sms_farsi_cost_rial     bigint CHECK (sms_farsi_cost_rial IS NULL OR sms_farsi_cost_rial >= 0),
    sms_english_cost_rial   bigint CHECK (sms_english_cost_rial IS NULL OR sms_english_cost_rial >= 0),
    min_allowed_credit_rial bigint CHECK (min_allowed_credit_rial IS NULL OR min_allowed_credit_rial >= 0),
    sender_lines            text[] NOT NULL DEFAULT '{}',
    adopted                 boolean NOT NULL DEFAULT false,
    provisioned_at          timestamptz,
    last_synced_at          timestamptz,
    suspended_at            timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT kavenegar_business_accounts_one_per_business UNIQUE (business_id),
    CONSTRAINT kavenegar_business_accounts_one_per_localid UNIQUE (localid),
    CONSTRAINT kavenegar_business_accounts_username_unique UNIQUE (username)
);

CREATE INDEX kavenegar_business_accounts_state
    ON kavenegar_business_accounts (provision_state, updated_at);

ALTER TABLE kavenegar_business_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kavenegar_business_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kavenegar_business_accounts FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Child credentials — platform-only
-- ---------------------------------------------------------------------------

CREATE TABLE kavenegar_account_credentials (
    account_id      uuid PRIMARY KEY REFERENCES kavenegar_business_accounts(id) ON DELETE CASCADE,
    -- POSKVN1 | IV(12) | GCM tag(16) | ciphertext, AES-256-GCM with the
    -- platform realm secret. The magic makes a value piped into the wrong
    -- decryptor fail closed instead of returning plausible nonsense.
    api_key_enc     bytea NOT NULL,
    api_key_version integer NOT NULL DEFAULT 1 CHECK (api_key_version > 0),
    -- Last four characters only, for the console's "is this the key I think it
    -- is" question. Never enough to send.
    api_key_hint    text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    rotated_at      timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE kavenegar_account_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE kavenegar_account_credentials FORCE ROW LEVEL SECURITY;
-- No tenant policy: like platform_sms_config, a child key is platform
-- infrastructure. Rows are read under the documented `kavenegar-credentials`
-- bypass by the outbox credential resolver and by the console services.
CREATE POLICY platform_only ON kavenegar_account_credentials FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

-- ---------------------------------------------------------------------------
-- Provisioning / reconciliation queue
-- ---------------------------------------------------------------------------

CREATE TABLE kavenegar_provisioning_jobs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    account_id        uuid REFERENCES kavenegar_business_accounts(id) ON DELETE SET NULL,
    job_kind          text NOT NULL CHECK (job_kind IN (
                          'provision', 'sync', 'suspend', 'reactivate', 'rotate_key', 'adopt'
                      )),
    state             text NOT NULL DEFAULT 'queued' CHECK (state IN (
                          'queued', 'running', 'succeeded', 'failed', 'cancelled'
                      )),
    attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts      integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
    next_attempt_at   timestamptz NOT NULL DEFAULT now(),
    -- A bounded lease, so a worker that dies mid-call cannot strand a job
    -- forever. Reclaiming an expired lease is safe for every job kind: each
    -- one reconciles provider state before it writes anything.
    locked_by         text,
    lease_expires_at  timestamptz,
    -- The last provider-neutral error code. Provider strings/statuses never
    -- land here, so nothing can leak through an operator export.
    last_error_code   text,
    last_error_detail text,
    requested_by      uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    finished_at       timestamptz
);

-- At most ONE open job per business and kind: enqueueing is idempotent, so a
-- reactivation storm cannot spawn five provisions.
CREATE UNIQUE INDEX kavenegar_provisioning_jobs_one_open
    ON kavenegar_provisioning_jobs (business_id, job_kind)
    WHERE state IN ('queued', 'running');
CREATE INDEX kavenegar_provisioning_jobs_claim
    ON kavenegar_provisioning_jobs (next_attempt_at, created_at)
    WHERE state = 'queued';
CREATE INDEX kavenegar_provisioning_jobs_lease
    ON kavenegar_provisioning_jobs (lease_expires_at)
    WHERE state = 'running';
CREATE INDEX kavenegar_provisioning_jobs_business_history
    ON kavenegar_provisioning_jobs (business_id, created_at DESC);

ALTER TABLE kavenegar_provisioning_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE kavenegar_provisioning_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON kavenegar_provisioning_jobs FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

-- ---------------------------------------------------------------------------
-- Master -> child pre-funding journal (internal, never a tenant balance)
-- ---------------------------------------------------------------------------

CREATE TABLE kavenegar_credit_transfers (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    account_id        uuid NOT NULL REFERENCES kavenegar_business_accounts(id) ON DELETE RESTRICT,
    -- Positive funds a child, negative claws credit back. Rial, integer, as
    -- the provider's own `Credit` parameter.
    amount_rial       bigint NOT NULL CHECK (amount_rial <> 0),
    -- The request's identity. A retry with the same key is answered from the
    -- committed row, never by moving money twice.
    idempotency_key   text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
    state             text NOT NULL DEFAULT 'pending' CHECK (state IN (
                          'pending',        -- written before the provider call
                          'applied',        -- provider confirmed
                          'unknown',        -- transport timed out; reconcile balances before retry
                          'failed'          -- provider refused, no money moved
                      )),
    last_error_code   text,
    provider_reference text,
    -- The child's reported balance immediately after a confirmed transfer.
    -- Reconciliation evidence, not a spendable balance: tenants never see it.
    balance_after_rial bigint CHECK (balance_after_rial IS NULL OR balance_after_rial >= 0),
    reason            text,
    requested_by      uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    applied_at        timestamptz,
    CONSTRAINT kavenegar_credit_transfers_idempotency UNIQUE (idempotency_key)
);

CREATE INDEX kavenegar_credit_transfers_business
    ON kavenegar_credit_transfers (business_id, created_at DESC);
CREATE INDEX kavenegar_credit_transfers_unresolved
    ON kavenegar_credit_transfers (created_at)
    WHERE state IN ('pending', 'unknown');

ALTER TABLE kavenegar_credit_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE kavenegar_credit_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON kavenegar_credit_transfers FOR ALL
    USING (app_rls_bypass())
    WITH CHECK (app_rls_bypass());

-- ---------------------------------------------------------------------------
-- Provider-reported cost evidence on the existing outbox
-- ---------------------------------------------------------------------------

-- The retail charge stays exactly where it was (wallet hold/settle at the
-- Billing-owned rate). This column only records what the provider actually
-- charged the PLATFORM for the send, so wholesale cost and margin can be
-- reconciled without touching the tenant's wallet or inventing a second rate.
ALTER TABLE message_outbox
    ADD COLUMN provider_cost_rial bigint
        CHECK (provider_cost_rial IS NULL OR provider_cost_rial >= 0);
