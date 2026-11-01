-- ============================================================================
-- 0278_torob_managed_shops.sql — issue #894, Wave 1: the Torob foundation.
--
-- Torob (#894) is a **managed service inside Growth**: a business opens Growth →
-- «مدیریت ترب», sees every website Bizamiz already manages for it, and connects
-- each one's Torob shop in three steps. No pasted URLs, no second dashboard, no
-- separate product editor.
--
-- Wave 1 is the foundation, and it is deliberately the smallest thing that can
-- be true: *which managed website may become a Torob shop, and who says so.*
-- The product feed (Wave 2), the storefront runtimes (Wave 3), the UI (Wave 4)
-- and attribution (Wave 5) all read this table; none of them decides eligibility
-- for itself, because that is how a pasted URL becomes an enrolled shop.
--
-- ## Why this table exists at all
--
-- The two website systems already have their own registries — `integration_connections`
-- (provider 'woocommerce') and `eshobe_cms_connections` — and Torob is a *channel
-- onto* them, not a third one. So there is no product catalogue here, no order,
-- no customer: those stay where they are. What is new, and what cannot be derived
-- from either registry, is the channel relationship:
--
--   * which Torob shop belongs to which managed website (a business may have
--     several, and they must never mix);
--   * how that shop was authorized (partner flow, or a merchant's own token);
--   * what the merchant chose to publish;
--   * whether the channel is currently usable, and why not.
--
-- ## The eligibility rule, in the schema
--
-- `website_kind` + `source_connection_id` is a **soft reference** to one of two
-- tables, so a plain foreign key cannot express it. The guarantees that matter
-- are expressed as far as the database can and the rest as a service rule with
-- tests beside it:
--
--   * `UNIQUE (business_id, website_kind, source_connection_id)` — one shop per
--     website, ever, so "connect" is idempotent and a second call cannot create a
--     duplicate shop or a duplicate Torob registration.
--   * `UNIQUE (business_id, domain)` — one shop per domain inside a business. Two
--     businesses may legitimately have `shop.example` in a dev environment, so
--     this is scoped rather than global.
--   * `CHECK` that an authorized shop has a credential and an unauthorized one
--     does not: a row that claims `authorized` with no token is the state that
--     silently stops a feed, and a row that keeps a token after revocation is a
--     credential nobody is using.
--
-- ## Credentials
--
-- The merchant's own Shop API token (Torob's documented fallback when Bizamiz's
-- partner application is not available) is encrypted at rest with the same
-- realm secret as every other tenant credential, and is never returned by any
-- read path: `token_hint` exists so a screen can say «…۱۲۳۴» without carrying
-- the secret.
--
-- RLS: the standard tenant template, in this migration, per CLAUDE.md.
-- ============================================================================

CREATE TABLE torob_shops (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Which managed website system this shop mirrors. A soft reference by
    -- necessity: the two registries are different tables with different shapes.
    website_kind            text NOT NULL CHECK (website_kind IN ('woocommerce', 'eshobe_cms')),
    source_connection_id    uuid NOT NULL,
    -- The website's own verified host, copied at connect time. It is what the
    -- product endpoint (Wave 2) is published for and what an `aud` claim is
    -- checked against, so it is stored rather than recomputed behind the
    -- caller's back — a domain that changes in the registry is a *repair*, not
    -- a silent redirect of a live feed.
    domain                  text NOT NULL CHECK (
                                char_length(trim(domain)) BETWEEN 3 AND 255
                                AND domain ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
                                AND domain LIKE '%.%'
                            ),
    -- Torob's connection lifecycle, in the merchant's terms.
    --   not_authorized → pending_approval → authorized
    --   any of them → revoked (explicit, never silent)
    authorization_state     text NOT NULL DEFAULT 'not_authorized' CHECK (authorization_state IN (
                                'not_authorized',
                                'pending_approval',
                                'authorized',
                                'revoked'
                            )),
    -- How it was authorized. `partner` is Bizamiz's own Shop Generator
    -- application; `manual_token` is the merchant's own Shop API token, which
    -- the issue requires as a documented fallback rather than a failure.
    auth_mode               text NOT NULL DEFAULT 'partner' CHECK (auth_mode IN ('partner', 'manual_token')),
    -- The merchant's token, encrypted. NULL in partner mode, and NULL again once
    -- revoked (a credential nobody uses is a liability, not a convenience).
    token_ciphertext        text,
    token_hint              text,
    -- Torob's own shop identifier, once the partner flow returns one.
    provider_shop_id        text,
    -- What the merchant chose to publish. Wave 2 reads it; Wave 1 only stores it,
    -- because the choice has to exist before a feed can honour it.
    publication_rule        text NOT NULL DEFAULT 'all' CHECK (publication_rule IN ('all', 'selected')),
    -- The channel switch. Off means "do not run managed background operations",
    -- never "delete anything": a disconnected website keeps its Torob shop.
    enabled                 boolean NOT NULL DEFAULT false,
    -- Health of the *connection*, not of Torob's index. `attention` carries a
    -- reason code from a closed vocabulary so the console can explain it without
    -- leaking a provider string.
    health                  text NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown', 'healthy', 'attention')),
    health_reason           text,
    last_checked_at         timestamptz,
    created_by              uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT torob_shops_one_per_website
        UNIQUE (business_id, website_kind, source_connection_id),
    CONSTRAINT torob_shops_one_per_domain
        UNIQUE (business_id, domain),
    -- An authorized shop must have something to authorize with; an unauthorized
    -- or revoked one must not keep a secret it no longer uses. Expressed as a
    -- CASE rather than a disjunction of three, because the state is the thing
    -- being decided and a flat OR chain is where one branch silently stops
    -- being reachable.
    CONSTRAINT torob_shops_credential_matches_state CHECK (
        CASE authorization_state
            WHEN 'authorized' THEN
                (auth_mode = 'manual_token' AND token_ciphertext IS NOT NULL)
                OR (auth_mode = 'partner' AND provider_shop_id IS NOT NULL)
            -- A partner request waiting on Torob's approval has no token of ours
            -- yet, and a manual token never waits: it works or it is refused.
            WHEN 'pending_approval' THEN
                auth_mode = 'partner' AND token_ciphertext IS NULL
            ELSE token_ciphertext IS NULL
        END
    ),
    -- A hint without a secret is a screen showing digits of nothing.
    CONSTRAINT torob_shops_hint_follows_token CHECK (
        token_hint IS NULL OR token_ciphertext IS NOT NULL
    ),
    -- A health reason is only meaningful beside `attention`.
    CONSTRAINT torob_shops_reason_only_when_attention CHECK (
        health_reason IS NULL OR health = 'attention'
    )
);

CREATE INDEX idx_torob_shops_business
    ON torob_shops (business_id, created_at DESC);
-- The product endpoint (Wave 2) resolves a shop from the request's host, so this
-- is the lookup it will make on every call.
CREATE INDEX idx_torob_shops_domain
    ON torob_shops (domain) WHERE enabled;

ALTER TABLE torob_shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE torob_shops FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON torob_shops FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE torob_shops IS
    'Issue #894 Wave 1: one Torob shop per managed website (WooCommerce or Eshobe CMS). Eligibility and credentials live here; the catalogue, orders and customers stay in their own registries.';
COMMENT ON COLUMN torob_shops.source_connection_id IS
    'Soft reference: integration_connections.id when website_kind = woocommerce, eshobe_cms_connections.id when eshobe_cms. Verified by the service against the tenant''s own registries, never trusted from a request.';
COMMENT ON COLUMN torob_shops.token_ciphertext IS
    'Merchant Shop API token, encrypted with the realm secret. Never returned by any read path; token_hint is what a screen shows.';
