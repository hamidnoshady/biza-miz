-- ============================================================================
-- 0266_kavenegar_lookup_triggers.sql — issue #902 §5, the product half.
--
-- §5d made one message sendable: an approved template, a mapped token list, the
-- child's own key, one reserve and one settle. What it did NOT have was a
-- reason. Until now the only caller was the console's «ارسال آزمایشی» — an
-- operator proving a template works, not a business telling a customer that
-- their order is ready.
--
-- This migration is where a *business event* becomes a message, and it is two
-- tables because those are two different facts:
--
--   * `kavenegar_lookup_triggers` — the business's standing decision: "when an
--     order is ready, send this approved message". Off by default, per trigger,
--     named by a closed vocabulary (see src/lib/kavenegar/lookup-trigger-facts.ts).
--     A trigger with no row here sends nothing, so nothing is ever sent on a
--     business's behalf because a migration thought it was a good idea.
--   * `kavenegar_lookup_trigger_sends` — what actually happened, one row per
--     *fact* rather than per attempt. The UNIQUE on
--     (business_id, trigger_key, event_key) is the whole idempotency story: a
--     kitchen bump replayed from an offline terminal, a retried request and a
--     second terminal line on the same ticket all collide here, so one order
--     ready notice costs one message.
--
-- ## Why `login_code` is not in this vocabulary
--
-- The platform's library (§5, migration 0264) also carries a login code, and it
-- is deliberately absent from the CHECK below. A login OTP is sent from the
-- **platform-auth transport** (`platform_sms_config`, the master account) and
-- charged to the platform, which is what lets a member log in when Growth is
-- off, their business's child account is suspended, or the marketing wallet is
-- empty (issue #902 DoD #9). This table's rows are, by construction, sends on
-- the **business's** child account and charged to the **business's** wallet —
-- so putting the login code here would be the exact outage the issue forbids.
-- The refusal is in the schema as well as in the code, because a future
-- migration that "completes the catalogue" must fail rather than quietly make
-- authentication depend on a tenant's credit.
--
-- ## Consent
--
-- A row here is permission to *consider* a send, never permission to make one:
-- the dispatcher still reads the customer's own `parties.sms_consent` and their
-- reachable mobile before the first provider call. Transactional is not a
-- synonym for unconsented.
-- ============================================================================

CREATE TABLE kavenegar_lookup_triggers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The event this row is about. Closed vocabulary, mirrored in
    -- MANAGED_LOOKUP_TRIGGERS; `login_code` is absent on purpose (see above).
    trigger_key text NOT NULL CHECK (trigger_key IN ('order_ready', 'payment_received')),
    -- The business's own approved message. ON DELETE CASCADE: removing the
    -- template from the catalog removes the automation with it — a trigger
    -- pointing at a row that no longer exists would be a send that cannot
    -- happen while the screen still says it will.
    template_id uuid NOT NULL REFERENCES kavenegar_lookup_templates(id) ON DELETE CASCADE,
    enabled     boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT kavenegar_lookup_triggers_per_business UNIQUE (business_id, trigger_key)
);

COMMENT ON TABLE kavenegar_lookup_triggers IS
    'Issue #902 §5: the business''s standing "when X happens, send this approved message" decisions. Off until the business turns one on.';
COMMENT ON COLUMN kavenegar_lookup_triggers.trigger_key IS
    'Closed vocabulary (order_ready, payment_received). login_code is refused: auth OTP runs on the platform-auth transport and never on a tenant wallet.';

CREATE INDEX idx_kavenegar_lookup_triggers_enabled
    ON kavenegar_lookup_triggers (business_id, trigger_key)
    WHERE enabled;

ALTER TABLE kavenegar_lookup_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE kavenegar_lookup_triggers FORCE ROW LEVEL SECURITY;
-- Tenant-scoped, like the catalog it points into: the business reads and edits
-- its own automation; only services write the send log below.
CREATE POLICY tenant_isolation ON kavenegar_lookup_triggers FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- The send log: one row per fact, and the idempotency key for the whole slice
-- ---------------------------------------------------------------------------
CREATE TABLE kavenegar_lookup_trigger_sends (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    trigger_key         text NOT NULL CHECK (trigger_key IN ('order_ready', 'payment_received')),
    -- The identity of the fact, not of this call: `order:<uuid>`. A replay of
    -- the same bump collides; a second order does not.
    event_key           text NOT NULL CHECK (length(btrim(event_key)) BETWEEN 1 AND 120),
    -- pending → sent | blocked | failed | unknown | skipped. `pending` is the
    -- claim (the row exists before the provider is called), so a crash mid-send
    -- is visible as a stuck claim rather than as a silent duplicate later.
    status              text NOT NULL CHECK (
                            status IN ('pending', 'sent', 'blocked', 'failed', 'unknown', 'skipped')
                        ),
    -- Provider-neutral reason: a blocked code (trigger_disabled, no_consent,
    -- insufficient_credit…), a provider classification, or NULL when sent.
    code                text,
    template_id         uuid REFERENCES kavenegar_lookup_templates(id) ON DELETE SET NULL,
    provider_message_id text,
    segments            integer,
    charged_rial        bigint NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT kavenegar_lookup_trigger_sends_once UNIQUE (business_id, trigger_key, event_key)
);

COMMENT ON TABLE kavenegar_lookup_trigger_sends IS
    'Issue #902 §5: one row per (business, trigger, fact). UNIQUE is the idempotency key — a replayed event cannot send twice.';
COMMENT ON COLUMN kavenegar_lookup_trigger_sends.code IS
    'Provider-neutral refusal/failure code. Raw provider text is never stored: it is not actionable and leaks supplier vocabulary.';
-- Deliberately no recipient column: `parties.phone_e164` is the one copy of a
-- customer's number, and a support question ("did we text this order?") is
-- answered by the event key. The issue's §7 asks for audit without PII.

CREATE INDEX idx_kavenegar_lookup_trigger_sends_recent
    ON kavenegar_lookup_trigger_sends (business_id, created_at DESC);

ALTER TABLE kavenegar_lookup_trigger_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE kavenegar_lookup_trigger_sends FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kavenegar_lookup_trigger_sends FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
