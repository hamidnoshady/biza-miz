-- ============================================================================
-- 0323_growth_cashback_rewards.sql — issue #901, Wave 2 (P0 financial engine).
--
-- The campaign builder (0262) stores a *definition*: a typed trigger, a reward
-- and hard limits. This migration adds the money side of that definition:
--
--   * the lifecycle columns an approval/activation needs (`approved_*`,
--     `activated_at`, and the optional scheduled window);
--   * `growth_campaign_budget_reservations` — one active row per granted order,
--     so the campaign's hard budget is a transactionally reserved number and
--     not a SUM over a moving ledger;
--   * `growth_reward_entitlements` — one reward per (campaign, order), the
--     unique key that makes every replay, retry and reconnect a no-op;
--   * `growth_reward_events` — the append-only financial events a balance is
--     reconstructed from (never a mutable counter);
--   * `growth_reward_redemptions` — one idempotent payout per client request;
--   * account `2445` (بازگشت وجه تبلیغاتی) on every business's chart, because a
--     cashback reward is its own liability and must never be posted through the
--     store-credit (2410) or sales-return (4400) path. 2440 is AEC's retention
--     liability, so the cashback account takes the free 2445.
--
-- Accounting treatment used by the posting rules (campaign-posting-rules.ts):
--
--   earned    Dr 5600 بازاریابی و تبلیغات      / Cr 2445 بازگشت وجه تبلیغاتی
--   redeemed  Dr 2445                          / Cr 1100 صندوق (or 1110 بانک)
--   reversed  Dr 2445                          / Cr 5600
--   expired   Dr 2445                          / Cr 5600
--
-- The liability is recognised at grant time (conservative), and "becomes
-- available" is a spendability change, not a second posting. A reward that is
-- already spent cannot be clawed back by a refund, so a reversal is capped at
-- the unspent remainder and the shortfall is recorded on the entitlement
-- (`unrecovered_rial`) for the operator report.
--
-- Additive: no existing table, row or posting is rewritten.
-- ============================================================================

-- ── campaign lifecycle ──────────────────────────────────────────────────────

ALTER TABLE growth_campaigns
    ADD COLUMN approved_at  timestamptz,
    ADD COLUMN approved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN activated_at timestamptz,
    ADD COLUMN paused_at    timestamptz,
    ADD COLUMN starts_at    timestamptz,
    ADD COLUMN ends_at      timestamptz;

-- A window that ends before it starts can never pay; refuse it in the table
-- rather than trusting every future caller to remember.
ALTER TABLE growth_campaigns
    ADD CONSTRAINT growth_campaigns_window_ordered
    CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at);

-- The reward position names the exact version that granted it, and a composite
-- foreign key needs the referenced triple to be unique. Added here, before the
-- tables that reference it.
ALTER TABLE growth_campaign_versions
    ADD CONSTRAINT growth_campaign_versions_business_campaign_id_key
    UNIQUE (business_id, campaign_id, id);

-- ── the cashback liability account, on every existing chart ─────────────────

INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, '2445', 'بازگشت وجه تبلیغاتی (بدهی پاداش کمپین)', 'liability'::account_type, 'kol'::account_level, false
  FROM businesses b
  JOIN accounts p ON p.business_id = b.id AND p.code = '2000'
ON CONFLICT (business_id, code) DO NOTHING;

-- ── budget reservations ─────────────────────────────────────────────────────
-- The hard budget is enforced against this table inside the same transaction
-- (and under the campaign's advisory lock) that writes the entitlement. A row
-- is released when the reward is reversed, expired or fully redeemed; the
-- campaign's remaining budget is `totalBudget - SUM(active reservations)`.
CREATE TABLE growth_campaign_budget_reservations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    campaign_id  uuid NOT NULL,
    order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    amount_rial  bigint NOT NULL CHECK (amount_rial > 0),
    released_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    -- One reservation per order per campaign: the same sale can never reserve
    -- twice, whoever replays the event.
    UNIQUE (campaign_id, order_id),
    FOREIGN KEY (business_id, campaign_id) REFERENCES growth_campaigns (business_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_growth_campaign_reservations_active
    ON growth_campaign_budget_reservations (campaign_id)
    WHERE released_at IS NULL;

-- ── entitlements ────────────────────────────────────────────────────────────
-- The row is the *position*: what this (campaign, order) pair earned and what
-- has happened to it. Every amount column is a projection of
-- `growth_reward_events`; the events are the ledger and the source of truth.
CREATE TABLE growth_reward_entitlements (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    campaign_id       uuid NOT NULL,
    campaign_version_id uuid NOT NULL REFERENCES growth_campaign_versions(id) ON DELETE RESTRICT,
    order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    customer_id       uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    earned_rial       bigint NOT NULL CHECK (earned_rial > 0),
    redeemed_rial     bigint NOT NULL DEFAULT 0 CHECK (redeemed_rial >= 0),
    reversed_rial     bigint NOT NULL DEFAULT 0 CHECK (reversed_rial >= 0),
    expired_rial      bigint NOT NULL DEFAULT 0 CHECK (expired_rial >= 0),
    -- A refund larger than the still-unspent reward cannot be recovered from
    -- the customer; it is recorded here so the report can show it honestly.
    unrecovered_rial  bigint NOT NULL DEFAULT 0 CHECK (unrecovered_rial >= 0),
    status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'available', 'partially_redeemed', 'redeemed', 'expired', 'reversed')),
    available_at      timestamptz NOT NULL,
    expires_at        timestamptz NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    -- Exactly one reward per order per campaign. This is the idempotency
    -- guarantee every duplicate webhook, worker restart and POS reconnect
    -- lands on.
    UNIQUE (campaign_id, order_id),
    -- The position can never claim to have paid more than it earned.
    CHECK (redeemed_rial + reversed_rial + expired_rial <= earned_rial),
    CHECK (expires_at > available_at),
    FOREIGN KEY (business_id, campaign_id) REFERENCES growth_campaigns (business_id, id) ON DELETE CASCADE,
    FOREIGN KEY (business_id, campaign_id, campaign_version_id)
        REFERENCES growth_campaign_versions (business_id, campaign_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_growth_reward_entitlements_customer
    ON growth_reward_entitlements (business_id, customer_id, status);
CREATE INDEX idx_growth_reward_entitlements_campaign
    ON growth_reward_entitlements (campaign_id, created_at DESC);
-- The "what can be spent right now" read, which the till performs on every
-- redemption.
CREATE INDEX idx_growth_reward_entitlements_spendable
    ON growth_reward_entitlements (business_id, customer_id, available_at, expires_at)
    WHERE status IN ('pending', 'available', 'partially_redeemed');

-- ── redemptions ─────────────────────────────────────────────────────────────
-- One row per payout request. `request_key` is the client's own idempotency
-- key, so a double-clicked button or a retried request pays once.
CREATE TABLE growth_reward_redemptions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id  uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
    amount_rial  bigint NOT NULL CHECK (amount_rial > 0),
    payout_method text NOT NULL CHECK (payout_method IN ('cash', 'bank')),
    request_key  text NOT NULL CHECK (char_length(request_key) BETWEEN 8 AND 128),
    entry_id     uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, request_key)
);

CREATE INDEX idx_growth_reward_redemptions_customer
    ON growth_reward_redemptions (business_id, customer_id, created_at DESC);

-- ── the append-only event ledger ────────────────────────────────────────────
CREATE TABLE growth_reward_events (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- CASCADE, guarded below: the ledger may only leave with the position it
    -- belongs to (a tenant or position deletion), never on its own.
    entitlement_id uuid NOT NULL REFERENCES growth_reward_entitlements(id) ON DELETE CASCADE,
    campaign_id    uuid NOT NULL,
    customer_id    uuid NOT NULL,
    event_type     text NOT NULL CHECK (event_type IN ('earned', 'redeemed', 'reversed', 'expired')),
    amount_rial    bigint NOT NULL CHECK (amount_rial > 0),
    order_id       uuid REFERENCES orders(id) ON DELETE RESTRICT,
    redemption_id  uuid REFERENCES growth_reward_redemptions(id) ON DELETE RESTRICT,
    reason         text,
    actor_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, id)
);

CREATE INDEX idx_growth_reward_events_entitlement ON growth_reward_events (entitlement_id, created_at);
CREATE INDEX idx_growth_reward_events_customer ON growth_reward_events (business_id, customer_id, created_at);
-- `earned` may only ever exist once per entitlement: a reward is granted once.
CREATE UNIQUE INDEX uq_growth_reward_events_earned
    ON growth_reward_events (entitlement_id) WHERE event_type = 'earned';
-- Expiry runs once per entitlement.
CREATE UNIQUE INDEX uq_growth_reward_events_expired
    ON growth_reward_events (entitlement_id) WHERE event_type = 'expired';

-- The ledger is append-only. Corrections are new events, never rewrites.
-- A delete is refused unless it is the cascade that follows its own position's
-- removal (the same shape growth_campaign_version_guard uses): the parent row
-- is already gone by the time the cascade reaches the child.
CREATE OR REPLACE FUNCTION growth_reward_events_append_only() RETURNS trigger AS $$
BEGIN
    -- A row may leave only after its own position has: that is the cascade a
    -- tenant or position deletion performs, not an edit of the ledger.
    IF TG_OP = 'DELETE'
       AND NOT EXISTS (SELECT 1 FROM growth_reward_entitlements e WHERE e.id = OLD.entitlement_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'growth_reward_event_immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_growth_reward_events_append_only
    BEFORE UPDATE OR DELETE ON growth_reward_events
    FOR EACH ROW EXECUTE FUNCTION growth_reward_events_append_only();

-- ── tenant isolation ────────────────────────────────────────────────────────
ALTER TABLE growth_campaign_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_campaign_budget_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON growth_campaign_budget_reservations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE growth_reward_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_reward_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON growth_reward_entitlements FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE growth_reward_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_reward_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON growth_reward_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE growth_reward_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_reward_redemptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON growth_reward_redemptions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
