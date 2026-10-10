-- ---------------------------------------------------------------------------
-- Issue #883 wave 3 — MCP credentials for the SUPERADMIN console.
--
-- Strictly separate from the tenant credential family (mcp_connections
-- starts at migration ~0206): a DIFFERENT table, a different token prefix
-- (`pospmcp_`, parsed by nothing tenant-side), and a different authority
-- model (per-tool PlatformCapability re-verified against the admin's current
-- role on every call). Crossover must not be plausible by construction, not
-- just denied at runtime.
--
-- `business_ids` bounds which businesses a credential may BRIDGE into for
-- the tools that take tenant targets; NULL means the whole platform.
-- The default in minting code is never changed silently to expand.
--
-- No tenant RLS here by design: this table is console-only, read through
-- withoutTenantScope after the console-gate already ran.
-- ---------------------------------------------------------------------------
CREATE TABLE platform_mcp_connections (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id      uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
    name          text NOT NULL,
    token_hash    text NOT NULL UNIQUE,
    capabilities  jsonb NOT NULL DEFAULT '[]',
    business_ids  jsonb,
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    last_used_at  timestamptz,
    expires_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz,
    CONSTRAINT platform_mcp_connections_cap_list
      CHECK (jsonb_typeof(capabilities) = 'array'),
    CONSTRAINT platform_mcp_connections_biz_list
      CHECK (business_ids IS NULL OR jsonb_typeof(business_ids) = 'array')
);
CREATE INDEX idx_platform_mcp_connections_admin
    ON platform_mcp_connections (admin_id, created_at DESC);
