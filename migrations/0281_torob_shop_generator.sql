-- ============================================================================
-- 0281_torob_shop_generator.sql — issue #894, Wave 3: the partner approval flow.
--
-- Wave 1 stored the channel relationship and a state machine with one deliberate
-- gap: nothing could move `pending_approval` → `authorized` except a hand-written
-- UPDATE, because the Shop Generator API's approval step had not been built. This
-- migration carries the three facts that step needs, so the transition happens
-- because Torob approved something — never because a merchant clicked a button
-- that says so.
--
-- ## Why these three columns, and not a table
--
-- A connection is one row's worth of state: which connection Torob opened for this
-- shop (`provider_shop_id`, already there), where the merchant must approve it
-- (`approve_url`), when the 15-minute window opened (`authorization_requested_at`),
-- and why the last attempt failed (`authorization_error`). A separate table would
-- duplicate the shop's identity to hold four nullable values that only make sense
-- beside it.
--
-- ## The constraints, and the mistakes they prevent
--
--   * **`approve_url` only exists while pending.** Once a shop is authorized the
--     URL is dead, and a row that keeps it invites a screen to offer "continue"
--     for an approval that already happened. The URL must also be https: Torob only
--     redirects to an https `return_url`, and an http one here is a flow that cannot
--     complete.
--   * **`pending_approval` must carry the moment the request was made.** Torob's
--     document gives the flow 15 minutes, and re-requesting restarts them. Without
--     the timestamp the platform would have to guess, and guessing short tells a
--     merchant their approval expired when it had not; guessing long sends them to
--     a Torob page that has already given up.
--   * **A failure reason only exists on a shop that is not authorized.** An
--     authorized row with an error beside it is a screen contradicting itself.
--
-- ## What is deliberately *not* here
--
-- No `status` column mirroring Torob's five connection states. The shop's
-- `authorization_state` is the platform's own four states, and a second, nearly
-- identical vocabulary is how the two drift until one of them lies. `provider_shop_id`
-- is the link back to Torob when a fresh answer is needed.
-- ============================================================================

ALTER TABLE torob_shops
    ADD COLUMN approve_url                text,
    ADD COLUMN authorization_requested_at timestamptz,
    ADD COLUMN authorization_error        text;

ALTER TABLE torob_shops
    ADD CONSTRAINT torob_shops_approve_url_only_pending CHECK (
        approve_url IS NULL
        OR (
            authorization_state = 'pending_approval'
            AND approve_url LIKE 'https://%'
        )
    ),
    ADD CONSTRAINT torob_shops_pending_has_request_time CHECK (
        authorization_state <> 'pending_approval'
        OR authorization_requested_at IS NOT NULL
    ),
    ADD CONSTRAINT torob_shops_error_not_when_authorized CHECK (
        authorization_error IS NULL
        OR authorization_state <> 'authorized'
    ),
    -- The vocabulary the service writes, named in the schema so a stray string from
    -- a provider response cannot become a reason a screen has no sentence for.
    ADD CONSTRAINT torob_shops_error_vocabulary CHECK (
        authorization_error IS NULL
        OR authorization_error IN (
            'denied',
            'expired',
            'code_invalid',
            'not_configured',
            'unauthorized',
            'not_a_generator',
            'no_such_shop',
            'connection_not_found',
            'invalid_request',
            'provider_error',
            'timeout'
        )
    );

-- A pending shop is found by the connection id the merchant's browser comes back
-- with, so that is the lookup shape. Partial: only pending rows are ever searched.
CREATE INDEX idx_torob_shops_pending_connection
    ON torob_shops (business_id, provider_shop_id)
    WHERE authorization_state = 'pending_approval';

COMMENT ON COLUMN torob_shops.approve_url IS
    'Issue #894 Wave 3: the Torob page the merchant approves the connection on. Only while pending_approval, and cleared the moment the flow ends.';
COMMENT ON COLUMN torob_shops.authorization_requested_at IS
    'When the Shop Generator connection was requested. Torob gives the whole flow 15 minutes from here; a re-request restarts the clock.';
COMMENT ON COLUMN torob_shops.authorization_error IS
    'Why the last approval attempt failed, from a closed vocabulary. Never set on an authorized shop.';
