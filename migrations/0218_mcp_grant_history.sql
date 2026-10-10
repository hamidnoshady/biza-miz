-- ---------------------------------------------------------------------------
-- Issue #883 §1 follow-up — a consent-grants audit trail per MCP connection.
--
-- The wave-2 grants document answers "what may this connection do?" This
-- table answers "who granted it, through which interface, and when did that
-- change?" — minting, every PATCH-narrow/widen, revocation. `ai_action_audit`
-- already records what a connection DID; that becomes very hard to interpret
-- without knowing what it was ALLOWED to do at the time, and the history of
-- that allowance cannot live on `mcp_connections` (the row is overwritten).
--
-- Rows are append-once. Nothing updates or deletes them: the table is the
-- story. `actor_user_id` is NULL for system-caused events (there are none
-- yet — every grant change is a human choice, and that choice is always
-- attributable).
-- ---------------------------------------------------------------------------
CREATE TABLE mcp_grant_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('minted', 'access_changed', 'revoked')),
    -- The full allowance AFTER the event: scopes, write mode, grants. Snapshots
    -- (not diffs) so any single row tells the whole story at that instant.
    scopes        text[] NOT NULL,
    write_mode    text NOT NULL,
    grants        jsonb,
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    -- Which surface the choice came from, so the history can say "the owner
    -- consented in the OAuth screen" vs "someone edited the panel".
    via           text NOT NULL CHECK (via IN ('api', 'oauth_consent', 'system')),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mcp_grant_events_connection
    ON mcp_grant_events (connection_id, created_at);
CREATE INDEX idx_mcp_grant_events_business
    ON mcp_grant_events (business_id, created_at);

-- Same RLS template every tenant table gets (see 0021 + the isolation test):
-- tenant_isolation, FOR ALL, the shared app_* functions, and FORCE so even
-- the table owner is subject to the policy.
ALTER TABLE mcp_grant_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_grant_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_grant_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
