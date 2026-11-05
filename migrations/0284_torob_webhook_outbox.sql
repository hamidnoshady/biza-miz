-- ============================================================================
-- 0284_torob_webhook_outbox.sql — issue #894, Wave 5b: telling Torob what
-- changed, without telling it twice and without losing it.
--
-- The Product API is Torob pulling from us, on Torob's schedule. The Product
-- Webhook is us telling Torob "these pages changed" so it can pull them sooner.
-- That is the whole of it, and it is the last P0 piece of the epic: without it a
-- shop waits for a crawl, and with a naive version a busy shop sends the same
-- page sixty times an hour and gets rate-limited into silence.
--
-- ## One row per page, not per change
--
-- A shop that sets a price three times in a minute has one thing to tell Torob:
-- that page changed. The UNIQUE on `(business_id, shop_id, page_unique)` is the
-- coalescing rule, and re-enqueuing is an UPDATE — the same shape the WooCommerce
-- outbox uses for `stock.set`. A queue that grows per change would make the
-- merchant's only honest answer to "how far behind am I" a number about events
-- rather than products.
--
-- ## What the row is *not*
--
-- It carries no product name, price or stock. The webhook's whole payload is
-- `page_url` + `page_unique` — Torob then fetches the page itself through the
-- Product API — so copying a price here would only create a second copy that can
-- disagree with what Torob actually reads. `page_updated_at` is kept solely so
-- reconciliation can tell whether the queued notice is older than the product.
--
-- ## States, and why there is no `sending`
--
--   pending  waiting for the next drain, due at `next_attempt_at`
--   sent     Torob answered 200 — **accepted into its queue**, not indexed
--   dead     tried enough times, or refused in a way retrying cannot fix
--
-- A `sending` state would need a lease and a reaper; the drain instead claims its
-- batch inside one transaction sub-select (`FOR UPDATE SKIP LOCKED`) and marks the
-- rows in the same transaction it sends them in... which it must not do, because
-- the HTTP call is not inside that transaction. So the rows are claimed by setting
-- `next_attempt_at` forward in the claim, and a crash between claim and send costs
-- one backoff interval, not a lost notice. That trade is deliberate: at-least-once
-- delivery is correct here, because the webhook's only effect is "please re-fetch",
-- and fetching a page twice is free.
--
-- ## The batch log, and the one thing it must never claim
--
-- `torob_webhook_batches` records every request: how many items, whether Torob
-- accepted it, and the error if not. It is what makes "rate limited", "refused" and
-- "dead-lettered" observable from a screen instead of only from a log line. A 200
-- is stored as `accepted` and never as `indexed`: the document says so twice, and
-- the epic's central rule is that these are different facts.
--
-- Tenant RLS on both tables, per CLAUDE.md.
-- ============================================================================

CREATE TABLE torob_webhook_outbox (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    shop_id             uuid NOT NULL,
    -- Torob's identity for the page: the same `page_unique` the feed publishes.
    page_unique         text NOT NULL CHECK (char_length(page_unique) BETWEEN 1 AND 200),
    -- Absolute URL, re-derived from the shop's own route at send time. Stored so a
    -- drain does not have to rebuild a feed to know what it is sending.
    page_url            text NOT NULL CHECK (page_url LIKE 'http://%' OR page_url LIKE 'https://%'),
    -- Why it is queued. Torob treats both the same way; the distinction is ours,
    -- and it is what the screen uses to say «محصول تازه» rather than «به‌روزشده».
    reason              text NOT NULL CHECK (reason IN ('added', 'updated')),
    state               text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'dead')),
    attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at     timestamptz NOT NULL DEFAULT now(),
    -- The last failure, from a closed vocabulary. Cleared on success.
    last_error          text,
    -- The product's own change stamp when the notice was queued, so reconciliation
    -- can tell "queued before the last edit" from "queued after it".
    page_updated_at     timestamptz,
    first_enqueued_at   timestamptz NOT NULL DEFAULT now(),
    sent_at             timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT torob_webhook_outbox_one_per_page
        UNIQUE (business_id, shop_id, page_unique),
    CONSTRAINT torob_webhook_outbox_shop_fk
        FOREIGN KEY (shop_id, business_id)
        REFERENCES torob_shops (id, business_id)
        ON DELETE CASCADE,
    -- A sent row has a time and no pending work; anything else has neither.
    CONSTRAINT torob_webhook_outbox_sent_at CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
    -- Only a dead row is allowed to keep the failure that killed it without also
    -- being scheduled: a pending row's error is history, a sent row's must be gone.
    CONSTRAINT torob_webhook_outbox_error_not_on_sent CHECK (state <> 'sent' OR last_error IS NULL),
    CONSTRAINT torob_webhook_outbox_error_vocabulary CHECK (
        last_error IS NULL
        OR last_error IN (
            'not_configured',
            'unauthorized',
            'domain_mismatch',
            'invalid_request',
            'rate_limited',
            'timeout',
            'provider_error',
            'shop_not_active'
        )
    )
);

-- The drain's only query: due rows for one shop, oldest first.
CREATE INDEX idx_torob_webhook_outbox_due
    ON torob_webhook_outbox (business_id, shop_id, next_attempt_at)
    WHERE state = 'pending';

ALTER TABLE torob_webhook_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE torob_webhook_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON torob_webhook_outbox FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- torob_webhook_batches — one row per request to Torob, accepted or not
-- ---------------------------------------------------------------------------
CREATE TABLE torob_webhook_batches (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    shop_id         uuid NOT NULL,
    -- How many pages the request carried. Never more than Torob's 100.
    items           integer NOT NULL CHECK (items BETWEEN 0 AND 100),
    -- `accepted` means Torob answered 200: queued for a refresh. It never means
    -- indexed, which only the Shop API's per-product statuses can say.
    outcome         text NOT NULL CHECK (outcome IN ('accepted', 'failed')),
    error           text,
    -- Which pages were in the batch, so a dead letter can be traced to a request
    -- without joining back through rows that have since moved on.
    page_uniques    text[] NOT NULL DEFAULT '{}',
    started_at      timestamptz NOT NULL,
    finished_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT torob_webhook_batches_shop_fk
        FOREIGN KEY (shop_id, business_id)
        REFERENCES torob_shops (id, business_id)
        ON DELETE CASCADE,
    CONSTRAINT torob_webhook_batches_error_matches_outcome
        CHECK ((outcome = 'failed') = (error IS NOT NULL)),
    -- A failed request carried no items, because nothing was accepted. An accepted
    -- one carried at least one, because Torob refuses an empty list.
    CONSTRAINT torob_webhook_batches_items_match_outcome CHECK (
        (outcome = 'accepted' AND items >= 1) OR (outcome = 'failed' AND items = 0)
    ),
    CONSTRAINT torob_webhook_batches_error_vocabulary CHECK (
        error IS NULL
        OR error IN (
            'not_configured',
            'unauthorized',
            'domain_mismatch',
            'invalid_request',
            'rate_limited',
            'timeout',
            'provider_error',
            'shop_not_active'
        )
    )
);

CREATE INDEX idx_torob_webhook_batches_shop
    ON torob_webhook_batches (business_id, shop_id, finished_at DESC);

ALTER TABLE torob_webhook_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE torob_webhook_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON torob_webhook_batches FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE torob_webhook_outbox IS
    'Issue #894 Wave 5b: pages waiting to be announced to Torob, one row per page. Re-enqueuing coalesces; a row carries only the page''s identity and URL, never a price or a name.';
COMMENT ON TABLE torob_webhook_batches IS
    'Issue #894 Wave 5b: every request to Torob''s product webhook. `accepted` means queued for a refresh — never that Torob indexed, fetched or displayed anything.';
COMMENT ON COLUMN torob_webhook_outbox.page_updated_at IS
    'The product''s change stamp when the notice was queued. Reconciliation compares it against the catalogue to notice a notice older than the product.';
COMMENT ON COLUMN torob_webhook_outbox.next_attempt_at IS
    'When this row becomes due. A drain claims by pushing it forward, so a crash between claim and send costs one backoff interval rather than a lost notice.';
