-- Issue 951: extend the shared outbox allowlist.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='integration_outbox_events'::regclass AND conname='integration_outbox_events_entity_type_check';
  IF definition IS NULL THEN RAISE EXCEPTION 'outbox entity constraint missing'; END IF;
  ALTER TABLE integration_outbox_events DROP CONSTRAINT integration_outbox_events_entity_type_check;
  EXECUTE 'ALTER TABLE integration_outbox_events ADD CONSTRAINT integration_outbox_events_entity_type_check ' ||
    regexp_replace(definition, '^CHECK \(', 'CHECK (entity_type IN (''product_publish'', ''taxonomy_ensure'') OR ');
END $$;
