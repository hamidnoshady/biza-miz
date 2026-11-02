-- ============================================================================
-- 0282_outbox_cron_probe.sql — issue #1206 P0: asking the plugin to prove its
-- scheduler.
--
-- The app can see that a store is configured and that a token authenticates; it
-- cannot see a WP-Cron event run. The probe closes that gap by travelling the
-- same road as every other outbox job: the app queues one `cron_probe` row, the
-- plugin leases it inside a real cron invocation, schedules a *second*,
-- separately observed probe, and its result comes back as signed telemetry
-- carrying the same correlation id.
--
-- That row needs a type of its own in the shared allowlist. It is not a data
-- operation — applying it changes no product, order or customer — so it is
-- declared apart from the push types and never appears in a plugin's own event
-- vocabulary. Idempotent: re-running this migration is a no-op.
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
  IF position('cron_probe' in definition) > 0 THEN
    RETURN;
  END IF;
  ALTER TABLE integration_outbox_events DROP CONSTRAINT integration_outbox_events_entity_type_check;
  EXECUTE 'ALTER TABLE integration_outbox_events ADD CONSTRAINT integration_outbox_events_entity_type_check ' ||
    regexp_replace(definition, '^CHECK \(', 'CHECK (entity_type = ''cron_probe'' OR ');
END $$;
