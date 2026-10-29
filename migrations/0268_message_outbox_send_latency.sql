-- Issue #902 §6 — per-campaign delivery needs one number the schema cannot derive.
--
-- `0134` records when a row was queued (`created_at`), when it was attempted
-- (`last_attempt_at`) and when the provider accepted it (`sent_at`), so the
-- *queue* half of latency is already provable: `sent_at - created_at` is how
-- long a message waited for the drain. What was missing is the other half —
-- how long the provider itself took — because the drain called `send`, threw
-- the timing away, and moved on. That made "slow" indistinguishable from
-- "queued behind a backlog", which are opposite fixes.
--
-- `send_latency_ms` is written on every attempt (accepted or refused) from the
-- drain's own clock. Nullable on purpose: rows sent before this migration have
-- no measurement, and `null` must never be read as "instant".
--
-- The report that consumes it is `src/lib/campaign-delivery-report.ts`; the
-- column carries no supplier name, no provider code and nothing else that could
-- reach a tenant screen.

ALTER TABLE message_outbox
    ADD COLUMN send_latency_ms integer
        CHECK (send_latency_ms IS NULL OR send_latency_ms >= 0);

COMMENT ON COLUMN message_outbox.send_latency_ms IS
    'Issue #902 §6: how long the provider took to answer the last attempt, in milliseconds. NULL = not measured (rows queued before 0268).';
