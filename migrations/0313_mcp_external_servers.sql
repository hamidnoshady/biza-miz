-- ============================================================================
-- 0313_mcp_external_servers.sql — issue #1473 (MCP outbound, part 2).
--
-- Tenants may register an external MCP server (first use: an Eshobe CMS at
-- `/api/mcp`) and let the assistant call the tools it publishes. This is the
-- opposite direction from Phase 34's inbound connector: `posmcp_` credentials
-- expose Bizamiz's server and must never cause an outbound call, so nothing here
-- touches `mcp_connections`.
--
-- Two tables, both tenant-owned and FORCE RLS like every other tenant table:
--
--   1. `mcp_external_servers` — the registration: URL, credential ciphertext,
--      enabled flag, the operator's per-tool allowlist and the last discovery
--      result. `bearer_token_ciphertext` uses `src/lib/integrations/secrets.ts`
--      (AES-256-GCM, `v1.<iv>.<ciphertext>.<tag>`), the same scheme as the
--      WooCommerce and AI-gateway credentials — an administrative credential
--      rather than customer PII, which is why it is not a business-DEK
--      `field-crypto` column.
--   2. `mcp_external_calls` — one append-only row per invocation: server, tool,
--      outcome, duration, error code. Deliberately no arguments and no result:
--      an external CMS tool can return a customer's record, and an audit trail
--      must not become a second copy of the tenant's data.
--
-- The URL is validated against `MCP_OUTBOUND_ALLOWED_HOSTS` again on every call
-- (`src/lib/mcp/outbound/guard.ts`), not only here: a stored row must not outrun
-- the deployment's policy.
--
-- Rollback: drop `mcp_external_calls` then `mcp_external_servers`. Both are new
-- tables with no readers outside `src/lib/mcp/outbound/service.ts`, so an older
-- build ignores them.
-- ============================================================================

CREATE TABLE IF NOT EXISTS mcp_external_servers (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id              uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    slug                     text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,23}$'),
    label                    text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
    url                      text NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
    auth_kind                text NOT NULL DEFAULT 'none' CHECK (auth_kind IN ('none', 'bearer')),
    bearer_token_ciphertext  text,
    enabled                  boolean NOT NULL DEFAULT false,
    -- Empty means "every tool the last discovery returned". A non-empty array is
    -- the operator's narrowing and is re-checked on every call.
    allowed_tools            text[] NOT NULL DEFAULT '{}',
    -- The last `tools/list` result: name, title, description, inputSchema.
    discovered_tools         jsonb NOT NULL DEFAULT '[]'::jsonb,
    last_discovered_at       timestamptz,
    last_error               text,
    created_by               uuid,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mcp_external_servers_bearer CHECK (
        auth_kind = 'none' OR (bearer_token_ciphertext IS NOT NULL AND length(bearer_token_ciphertext) > 0)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_external_servers_business_slug_idx
    ON mcp_external_servers (business_id, slug);

CREATE INDEX IF NOT EXISTS mcp_external_servers_enabled_idx
    ON mcp_external_servers (business_id, enabled);

ALTER TABLE mcp_external_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_external_servers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_external_servers FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE IF NOT EXISTS mcp_external_calls (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    server_id      uuid NOT NULL REFERENCES mcp_external_servers(id) ON DELETE CASCADE,
    tool_name      text NOT NULL,
    status         text NOT NULL CHECK (status IN ('ok', 'refused', 'failed')),
    duration_ms    integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
    error_code     text,
    actor_user_id  uuid,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_external_calls_business_created_idx
    ON mcp_external_calls (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mcp_external_calls_server_idx
    ON mcp_external_calls (server_id, created_at DESC);

ALTER TABLE mcp_external_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_external_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_external_calls FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
