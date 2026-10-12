-- 0217_business_scope_sync_events.sql
--
-- Issue #869. A commission payout and the reversal of one are business-wide
-- money actions: a run covers every branch of the business, so the event that
-- records the payout belongs to no location. Until now every sync_events row
-- carried a location_id, and the only way to record a business-wide event would
-- have been to borrow a branch. That would send a branch a payout it never made.
--
-- This migration gives the outbox an explicit business scope:
--   scope        'location' (every row that exists, and every row a site writes)
--                or 'business' (a business-wide event the cloud records);
--   business_id  set on business-scope rows only;
--   location_id  NULL on business-scope rows only (the CHECK keeps the shapes apart).
--
-- Idempotency. (location_id, client_event_id) cannot de-duplicate a row with no
-- location, because NULLs never collide in a unique key. Business-scope rows get
-- their own partial unique index on (business_id, client_event_id), so a retried
-- or doubly-delivered event lands once, as location rows already do.
--
-- Tenant isolation. The existing policy scopes a row through its location, which
-- a business-scope row does not have, so such a row would be invisible to its own
-- business and could not be written at all. The policy gains a second branch that
-- scopes a business-scope row by business_id. Both branches keep the
-- app_rls_bypass() exemption and the app_current_business() test the rest of the
-- schema uses; the isolation suite checks that every tenant_isolation policy does.

ALTER TABLE sync_events ALTER COLUMN location_id DROP NOT NULL;

ALTER TABLE sync_events
    ADD COLUMN scope       text NOT NULL DEFAULT 'location' CHECK (scope IN ('location', 'business')),
    ADD COLUMN business_id uuid REFERENCES businesses(id) ON DELETE CASCADE;

ALTER TABLE sync_events
    ADD CONSTRAINT sync_events_scope_shape CHECK (
        (scope = 'location' AND location_id IS NOT NULL)
        OR (scope = 'business' AND location_id IS NULL AND business_id IS NOT NULL)
    );

CREATE UNIQUE INDEX uq_sync_events_business_client
    ON sync_events (business_id, client_event_id)
    WHERE scope = 'business';

DROP POLICY IF EXISTS tenant_isolation ON sync_events;
CREATE POLICY tenant_isolation ON sync_events FOR ALL
    USING (
        app_rls_bypass()
        OR (scope = 'location' AND location_id IN (
            SELECT l.id FROM locations l WHERE l.business_id = app_current_business()))
        OR (scope = 'business' AND business_id = app_current_business())
    )
    WITH CHECK (
        app_rls_bypass()
        OR (scope = 'location' AND location_id IN (
            SELECT l.id FROM locations l WHERE l.business_id = app_current_business()))
        OR (scope = 'business' AND business_id = app_current_business())
    );

COMMENT ON COLUMN sync_events.scope IS
    'location: a branch''s event (every existing row). business: a business-wide event the cloud records, with no location (#869).';
