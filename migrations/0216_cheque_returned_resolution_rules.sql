-- ---------------------------------------------------------------------------
-- Cheques: the rules that go with the `resolved` status added in 0215.
-- ---------------------------------------------------------------------------
-- A new enum value cannot be referenced in the transaction that created it, so
-- the constraint work lives in its own migration file.
--
-- 1. `resolved` is legal for both directions — a returned cheque of either side
--    can be settled another way or reclassified back to its control account.
-- 2. `cheque_events.event` learns the two resolution events. History stays
--    append-only: resolving a bounce adds an event, it never rewrites one.
-- 3. The lifecycle is now chronological by `occurred_on` (issue #828 (4)), and
--    the history/validation order is `occurred_on, created_at, id` — index it.

ALTER TABLE cheques DROP CONSTRAINT cheques_status_matches_direction;
ALTER TABLE cheques ADD CONSTRAINT cheques_status_matches_direction CHECK (
    (direction = 'receivable' AND status IN ('on_hand', 'in_collection', 'endorsed', 'cleared', 'bounced', 'resolved'))
    OR (direction = 'payable' AND status IN ('issued', 'cleared', 'bounced', 'cancelled', 'resolved'))
);

ALTER TABLE cheque_events DROP CONSTRAINT cheque_events_event_check;
ALTER TABLE cheque_events ADD CONSTRAINT cheque_events_event_check CHECK (
    event IN ('received', 'issued', 'deposited', 'endorsed', 'cleared', 'bounced', 'cancelled', 'settled', 'restored')
);

CREATE INDEX IF NOT EXISTS idx_cheque_events_chronology ON cheque_events (cheque_id, occurred_on, created_at, id);
