-- ============================================================================
-- 0285_outbox_desired_at.sql — issue #1206 P1: measure Bizamiz → store apply
-- latency instead of asserting it from the configured cadence.
--
-- An outbox row is a *desired-state* row: it is created the first time a
-- value must reach the store and then re-armed on every later change, so
-- `sent_at - created_at` is not a delivery time — for a busy product it is
-- the age of the product. What the p95 target needs is the moment the
-- CURRENT value became owed to the store. That is `desired_at`: stamped at
-- insert (the column default) and re-stamped by every upsert arm that
-- re-queues the row with a new value. `sent_at - desired_at` over recently
-- sent rows is then a measured desired → applied/ACKed latency, the mirror
-- image of the plugin-queue percentiles the plugin reports for Woo → Bizamiz.
--
-- Backfill is deliberately conservative so pre-migration rows cannot fake
-- history: already-sent rows get `desired_at = sent_at` (their true desire
-- time is unrecoverable; the latency query requires `sent_at > desired_at`,
-- so they contribute no samples), and still-owed rows get their last
-- `updated_at` — the closest recorded proxy for the last re-arm, which can
-- only understate how long they have been waiting. Real measurements take
-- over within one 30-day reporting window. Idempotent: re-running is a
-- no-op once the column is filled.
-- ============================================================================
ALTER TABLE integration_outbox_events ADD COLUMN IF NOT EXISTS desired_at timestamptz;

UPDATE integration_outbox_events
   SET desired_at = CASE
                      WHEN status = 'sent' AND sent_at IS NOT NULL THEN sent_at
                      ELSE COALESCE(updated_at, created_at)
                    END
 WHERE desired_at IS NULL;

ALTER TABLE integration_outbox_events ALTER COLUMN desired_at SET DEFAULT now();
ALTER TABLE integration_outbox_events ALTER COLUMN desired_at SET NOT NULL;
