-- ============================================================================
-- 0283_torob_observations.sql — issue #894, Wave 4b: what Torob says, not what
-- we sent.
--
-- Waves 1–4 built one side of the channel: which website may enroll, what its
-- feed is, who may fetch it, and which products the merchant chose. Every one of
-- those is a fact **we** produce. None of them can say whether a single product
-- is *on Torob* — that is Torob's answer, and the issue is blunt about it: the
-- five stages (catalogue-ready, API-ready, approved, webhook-accepted, indexed)
-- must never be conflated, and "accepted" never means "indexed".
--
-- The Torob Shop API is the documented way to read that answer back:
-- `GET /shop/` for the shop's status and a precomputed product summary,
-- `POST /products/` for the products as Torob sees them, one status list each.
-- This migration stores exactly that answer — and nothing derived from it.
--
-- ## Why the observation is a column set on the shop
--
-- `GET /shop/` answers about one shop: its status, a summary, and when the
-- summary was computed. The summary is small, provider-shaped and *replaced* on
-- every read (it is a snapshot, not a history), so a separate one-row-per-shop
-- table would add a join and no meaning.
--
-- Two honesty rules are in the constraints rather than in a comment:
--
--   * status, summary and `observed_at` arrive together or not at all — Torob
--     returns them in one response, and a row holding one of them without the
--     others is a screen inventing an observation;
--   * `observed_at` is when the **last successful** read happened, and
--     `observed_error` is why the **last attempt** failed. A failed attempt
--     therefore does not erase what Torob last told us — it says the number on
--     the screen is old, which is true, instead of showing nothing and implying
--     the shop has no products.
--
-- ## Why product states are their own table
--
-- One row per Torob page (`page_unique`, the identity the feed already uses), so
-- the per-product screen can put "what I publish" beside "what Torob shows"
-- without a second catalogue: the row carries Torob's status, price, stock flag
-- and error title — never a name, description or image of ours. `product_id` is
-- a soft reference back to `menu_items` (the uuid prefix of `page_unique`),
-- because a variant page's id is `product~variant` and a retail item's id is not
-- a `menu_items` row at all.
--
-- A row here is a snapshot too: a **complete** scan replaces the shop's rows, and
-- products Torob no longer returns are deleted, since the table's claim is "what
-- Torob currently shows" rather than a history. A bounded scan (a shop with more
-- pages than one refresh reads) deletes nothing, because absence from a partial
-- scan proves nothing at all.
--
-- ## Why the runs table exists
--
-- The issue asks for monitoring and for a "needs attention" that is observable.
-- `torob_status_runs` is the observation's own history: one row per attempt, its
-- outcome, how many products it saw, and Torob's status. Without it, a channel
-- that has failed to read Torob for three days looks exactly like one that was
-- never set up — and the difference is the whole support ticket.
--
-- Tenant RLS on both tables, per CLAUDE.md.
-- ============================================================================

ALTER TABLE torob_shops
    -- Torob's own shop status, exactly the four values `shop_api.md` documents.
    ADD COLUMN observed_status text CHECK (
        observed_status IS NULL
        OR observed_status IN ('active', 'blocked', 'crawler_check', 'crawler_active')
    ),
    -- `product_summary` from `GET /shop/`, as Torob sent it. Kept provider-shaped
    -- so the screen can show `calculated_at` and the error reasons verbatim.
    ADD COLUMN observed_summary jsonb,
    -- When the last **successful** read happened. Never moved by a failure.
    ADD COLUMN observed_at timestamptz,
    -- Why the last attempt failed, from a closed vocabulary. Cleared by a success.
    ADD COLUMN observed_error text;

ALTER TABLE torob_shops
    ADD CONSTRAINT torob_shops_observation_is_one_response CHECK (
        (observed_status IS NULL) = (observed_summary IS NULL)
        AND (observed_summary IS NULL) = (observed_at IS NULL)
    ),
    -- The vocabulary a read can fail with. The first three are ours — we never
    -- called Torob — and are here so a screen can say *why* nothing was read
    -- instead of showing an empty panel. The rest are Torob's answers.
    ADD CONSTRAINT torob_shops_observation_error_vocabulary CHECK (
        observed_error IS NULL
        OR observed_error IN (
            'not_authorized',
            'channel_disabled',
            'not_configured',
            'unauthorized',
            'forbidden',
            'not_found',
            'rate_limited',
            'invalid_request',
            'invalid_response',
            'timeout',
            'provider_error'
        )
    );

-- ---------------------------------------------------------------------------
-- torob_product_states — Torob's view of one page, one row each
-- ---------------------------------------------------------------------------
CREATE TABLE torob_product_states (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    shop_id         uuid NOT NULL,
    -- The page identity Torob echoes back: our feed's `page_unique` — the product
    -- uuid, or `product~variant` for one variant (`~` cannot occur in a uuid).
    page_unique     text NOT NULL CHECK (char_length(page_unique) BETWEEN 1 AND 200),
    -- Soft reference to the catalogue row, derived from `page_unique`. NULL when
    -- the id is not one of ours (a leftover page from an older feed, a retail
    -- item the catalogue read does not cover yet).
    product_id      uuid,
    -- Every status Torob reports, in its own priority order; `main_status` is the
    -- first. Empty means "no problem", which is not the same as "not on Torob".
    statuses        text[] NOT NULL DEFAULT '{}',
    main_status     text,
    -- Torob's price, in **integer Toman** as their API reports it. Not converted,
    -- not compared with ours: two prices are two facts, and a screen that showed
    -- only one of them would hide the mismatch that matters.
    price_toman     bigint CHECK (price_toman IS NULL OR price_toman >= 0),
    availability    boolean,
    -- The last crawl error, when Torob has one — their own words, for support.
    error_title     text,
    torob_updated_at timestamptz,
    observed_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT torob_product_states_one_per_page
        UNIQUE (business_id, shop_id, page_unique),
    CONSTRAINT torob_product_states_shop_fk
        FOREIGN KEY (shop_id, business_id)
        REFERENCES torob_shops (id, business_id)
        ON DELETE CASCADE,
    -- The documented statuses, so a stray provider string cannot become a status
    -- the screen has no sentence for. A status Torob adds later is dropped by the
    -- client until this list learns it; nothing is invented in the meantime.
    CONSTRAINT torob_product_states_status_vocabulary CHECK (
        statuses <@ ARRAY[
            'page_deleted_permanent_content',
            'page_deleted_temporary_content',
            'page_deleted_temporary_technical',
            'page_not_active',
            'page_not_accessible',
            'in_progress_add',
            'page_not_available',
            'base_not_confirmed',
            'price_not_valid',
            'base_not_merged',
            'base_image_rejected'
        ]::text[]
    ),
    -- The main status is Torob's own priority order, so it is `statuses[1]` —
    -- expressing it as anything else lets the two disagree.
    CONSTRAINT torob_product_states_main_is_first CHECK (
        (main_status IS NULL AND cardinality(statuses) = 0)
        OR (main_status IS NOT NULL AND main_status = statuses[1])
    )
);

-- The screen reads one shop's problem products; the refresh rewrites the shop.
CREATE INDEX idx_torob_product_states_shop
    ON torob_product_states (business_id, shop_id, main_status);

ALTER TABLE torob_product_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE torob_product_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON torob_product_states FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- torob_status_runs — one row per attempt to read Torob
-- ---------------------------------------------------------------------------
CREATE TABLE torob_status_runs (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    shop_id                 uuid NOT NULL,
    -- `observed`: Torob answered and the snapshot was stored.
    -- `failed`:   the attempt did not produce a snapshot, for `error`'s reason.
    outcome                 text NOT NULL CHECK (outcome IN ('observed', 'failed')),
    -- Torob's shop status at this observation (NULL on a failure).
    shop_status             text CHECK (
                                shop_status IS NULL
                                OR shop_status IN ('active', 'blocked', 'crawler_check', 'crawler_active')
                            ),
    products_seen           integer NOT NULL DEFAULT 0 CHECK (products_seen >= 0),
    products_with_problem   integer NOT NULL DEFAULT 0 CHECK (products_with_problem >= 0),
    -- Whether the scan read every page Torob had. A bounded scan explains why a
    -- product the merchant knows about may be missing from the snapshot.
    truncated               boolean NOT NULL DEFAULT false,
    error                   text,
    started_at              timestamptz NOT NULL,
    finished_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT torob_status_runs_shop_fk
        FOREIGN KEY (shop_id, business_id)
        REFERENCES torob_shops (id, business_id)
        ON DELETE CASCADE,
    CONSTRAINT torob_status_runs_error_matches_outcome
        CHECK ((outcome = 'failed') = (error IS NOT NULL)),
    CONSTRAINT torob_status_runs_status_matches_outcome
        CHECK ((outcome = 'observed') = (shop_status IS NOT NULL)),
    CONSTRAINT torob_status_runs_problems_within_seen
        CHECK (products_with_problem <= products_seen),
    CONSTRAINT torob_status_runs_error_vocabulary CHECK (
        error IS NULL
        OR error IN (
            'not_authorized',
            'channel_disabled',
            'not_configured',
            'unauthorized',
            'forbidden',
            'not_found',
            'rate_limited',
            'invalid_request',
            'invalid_response',
            'timeout',
            'provider_error'
        )
    )
);

CREATE INDEX idx_torob_status_runs_shop
    ON torob_status_runs (business_id, shop_id, finished_at DESC);

ALTER TABLE torob_status_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE torob_status_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON torob_status_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE torob_product_states IS
    'Issue #894 Wave 4b: Torob''s own view of each page of a shop (status, price, stock, last crawl error), read from the Shop API. Never a copy of the catalogue: names, images and descriptions stay in the storefront.';
COMMENT ON TABLE torob_status_runs IS
    'Issue #894 Wave 4b: every attempt to read a shop from the Torob Shop API, its outcome and how much it saw. A failed read is recorded so a channel that stopped talking to Torob looks different from one that was never set up.';
COMMENT ON COLUMN torob_shops.observed_at IS
    'When the last successful Shop API read happened. A failed attempt never moves it: the summary it belongs to is still the last thing Torob actually said.';
COMMENT ON COLUMN torob_shops.observed_error IS
    'Why the last Shop API attempt failed, from a closed vocabulary. Cleared by the next success.';
COMMENT ON COLUMN torob_product_states.main_status IS
    'Torob''s first status for this page — the one the Torob panel shows. NULL means Torob reports no problem at all.';
