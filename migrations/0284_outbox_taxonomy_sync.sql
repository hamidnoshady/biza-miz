-- ============================================================================
-- 0284_outbox_taxonomy_sync.sql — issue #1206 PERF-05: a taxonomy re-read is a
-- queued job, not a request that holds the browser open.
--
-- «همگام‌سازی از وب‌سایت» in REST mode used to read the whole tree inside the
-- POST: categories, tags, every attribute's terms, every custom taxonomy — one
-- HTTP round trip per page, sequentially, for a request a person is waiting on.
-- A store with two thousand terms and four attributes is already minutes of
-- work; a serverless function has seconds.
--
-- So the row travels the queue that already exists, with its retries, leases
-- and dead-letter handling, and this app's own tick executes it. That needs a
-- type of its own in the shared allowlist — it is neither a push to the store
-- nor a job the plugin may lease (the plugin's claim filters by capability, and
-- no capability names this one). Idempotent: re-running is a no-op.
-- ============================================================================
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid = 'integration_outbox_events'::regclass
      AND conname = 'integration_outbox_events_entity_type_check';
  IF definition IS NULL THEN
    RAISE EXCEPTION 'outbox entity constraint missing';
  END IF;
  IF position('taxonomy_sync' in definition) > 0 THEN
    RETURN;
  END IF;
  ALTER TABLE integration_outbox_events DROP CONSTRAINT integration_outbox_events_entity_type_check;
  EXECUTE 'ALTER TABLE integration_outbox_events ADD CONSTRAINT integration_outbox_events_entity_type_check ' ||
    regexp_replace(definition, '^CHECK \(', 'CHECK (entity_type = ''taxonomy_sync'' OR ');
END $$;
