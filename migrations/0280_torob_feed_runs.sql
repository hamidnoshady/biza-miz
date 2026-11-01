-- ============================================================================
-- 0280_torob_feed_runs.sql — issue #894, Wave 2: the feed, and what it did.
--
-- Wave 1 established *which* managed website owns a Torob shop. Wave 2 makes
-- that shop's catalogue expressible in Torob's terms (integer Toman, one item
-- per sellable page, 100 per page) and records **every build**, because the
-- three facts the issue insists must never be conflated have three different
-- sources and only the first is ours:
--
--   catalogue ready-ish   → the website's own registry (Wave 1)
--   feed built   = this table: what we assembled, what we skipped and why
--   accepted / indexed   = Torob's answer, which is *not* in this table
--
-- A row here therefore means "we produced this feed at this time", never "Torob
-- has it". The `status` vocabulary stops at `built` and `blocked` on purpose:
-- there is no `sent`, because sending is Wave 3's runtime and its proof is
-- Torob's response, not our intent.
--
-- Two things are added to `torob_shops`:
--
--   1. `public_product_path` — the storefront's own product route, as a template
--      with `{id}` and/or `{sku}`. A feed is a list of pages, so every item needs
--      a public URL, and only the manager that built the storefront knows what
--      that URL looks like. Making it a column (with the two managers' documented
--      defaults) keeps the guess in one place instead of inside the feed builder.
--   2. `include_out_of_stock` — whether an unavailable product is still listed
--      (with `availability: out_of_stock`) or left out. Default true: a product
--      that is temporarily sold out is still a page that exists, and dropping it
--      from the feed makes Torob forget it entirely.
--
-- Tenant RLS in this migration, per CLAUDE.md.
-- ============================================================================

ALTER TABLE torob_shops
    -- `{id}` → the product's local id, `{sku}` → its SKU. A template with
    -- neither placeholder produces the same URL for every product, which the
    -- feed would then refuse as `duplicate_page` — so it is refused here instead.
    ADD COLUMN public_product_path text NOT NULL DEFAULT '/products/{id}'
        CHECK (
            char_length(public_product_path) BETWEEN 1 AND 200
            AND (public_product_path LIKE '%{id}%' OR public_product_path LIKE '%{sku}%')
        ),
    ADD COLUMN include_out_of_stock boolean NOT NULL DEFAULT true;

-- The composite key every child row uses to prove it can never attach itself to
-- another business's shop (the same pattern `integration_connections` uses).
ALTER TABLE torob_shops
    ADD CONSTRAINT torob_shops_id_business UNIQUE (id, business_id);

-- The two managers ship different storefront routes; the default above is the
-- CMS one, so existing WooCommerce shops get theirs. A business that moves its
-- route edits this column (the screen that lets it is Wave 4's).
UPDATE torob_shops SET public_product_path = '/product/{id}' WHERE website_kind = 'woocommerce';

-- ---------------------------------------------------------------------------
-- torob_feed_runs — one row per build, with counts and skip reasons
-- ---------------------------------------------------------------------------
CREATE TABLE torob_feed_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    shop_id         uuid NOT NULL,
    -- `built`: a feed exists and every skipped page carries a reason.
    -- `blocked`: the shop cannot have a feed at all (not authorized, disabled,
    -- its website is gone) — recorded so the screen can say *why* rather than
    -- showing an empty catalogue that looks like a business with no products.
    status          text NOT NULL CHECK (status IN ('built', 'blocked')),
    -- The blocker, from the service's closed vocabulary. NULL when `built`.
    blocked_reason  text,
    items_total     integer NOT NULL DEFAULT 0 CHECK (items_total >= 0),
    items_in_stock  integer NOT NULL DEFAULT 0 CHECK (items_in_stock >= 0),
    items_out_of_stock integer NOT NULL DEFAULT 0 CHECK (items_out_of_stock >= 0),
    skipped_total   integer NOT NULL DEFAULT 0 CHECK (skipped_total >= 0),
    page_count      integer NOT NULL DEFAULT 1 CHECK (page_count >= 1),
    -- `[{ reason, count }]`, the same closed vocabulary the API returns. Small
    -- and provider-neutral: no product rows are copied here, so this table never
    -- becomes a second catalogue that drifts from the first.
    skipped_detail  jsonb NOT NULL DEFAULT '[]'::jsonb,
    built_at        timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT torob_feed_runs_blocked_reason
        CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL)),
    CONSTRAINT torob_feed_runs_counts
        CHECK (items_total = items_in_stock + items_out_of_stock),
    CONSTRAINT torob_feed_runs_shop_fk
        FOREIGN KEY (shop_id, business_id)
        REFERENCES torob_shops (id, business_id)
        ON DELETE CASCADE,
    UNIQUE (id, business_id)
);

CREATE INDEX idx_torob_feed_runs_shop
    ON torob_feed_runs (business_id, shop_id, built_at DESC);

ALTER TABLE torob_feed_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE torob_feed_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON torob_feed_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE torob_feed_runs IS
    'Issue #894 Wave 2: every build of a shop''s Torob feed, with counts and skip reasons. A row means we built it — never that Torob accepted or indexed it.';
COMMENT ON COLUMN torob_shops.public_product_path IS
    'The storefront''s product route as a template ({id}/{sku}). A feed item is a page, so every item needs the manager''s real route rather than a guess in the builder.';
COMMENT ON COLUMN torob_shops.include_out_of_stock IS
    'Whether a sold-out product is still listed with availability=out_of_stock instead of being dropped from the feed.';
