-- ---------------------------------------------------------------------------
-- OAuth 2.1 for the SUPERADMIN console's MCP endpoint (/api/platform/mcp).
--
-- Until now the console realm accepted only a pasted `pospmcp_` bearer token
-- (migration 0219). A client that connects from a URL alone — Claude.ai,
-- ChatGPT, Claude Code's `/mcp` login — has nowhere to paste one: it reads
-- the 401's WWW-Authenticate, discovers an authorization server, registers
-- itself and sends the admin through a consent screen. This adds the stores
-- that flow needs, in the shape of the tenant realm's (migration 0101) and
-- just as strictly separate from it: other tables, other token prefix
-- (`pospmcp_at_` / `pospmcp_rt_` / `pospmcp_ac_`), and the authority is still
-- the capability list the admin ticks on the consent screen, re-checked
-- against their CURRENT role on every call.
--
-- No tenant RLS by design, exactly like platform_mcp_connections: console-only
-- tables reached through withoutTenantScope after the console gate ran, listed
-- in EXEMPT_TABLES.
-- ---------------------------------------------------------------------------

-- RFC 7591 dynamic client registration. Public clients only (PKCE S256 is the
-- authentication), so there is no secret column.
CREATE TABLE platform_mcp_oauth_clients (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_name   text NOT NULL CHECK (char_length(trim(client_name)) BETWEEN 1 AND 200),
    redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
    client_uri    text,
    software_id   text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz
);
CREATE INDEX idx_platform_mcp_oauth_clients_created
    ON platform_mcp_oauth_clients (created_at DESC);

-- A connection now has an origin: pasted token (the original shape) or OAuth.
-- An OAuth connection carries no static token, so token_hash may be NULL — the
-- check keeps every pasted-token row exactly as strict as before.
ALTER TABLE platform_mcp_connections
    ADD COLUMN origin    text NOT NULL DEFAULT 'token' CHECK (origin IN ('token', 'oauth')),
    ADD COLUMN client_id uuid REFERENCES platform_mcp_oauth_clients(id) ON DELETE CASCADE,
    ALTER COLUMN token_hash DROP NOT NULL,
    ADD CONSTRAINT platform_mcp_connections_origin_token
        CHECK ((origin = 'token' AND token_hash IS NOT NULL AND client_id IS NULL)
            OR (origin = 'oauth' AND token_hash IS NULL AND client_id IS NOT NULL));

-- An authorization code: single use, short lived, PKCE-bound. The row is made
-- by the consent POST, after a signed-in owner admin chose the capabilities and
-- the business scope, so it already carries the decision.
CREATE TABLE platform_mcp_oauth_codes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       uuid NOT NULL REFERENCES platform_mcp_oauth_clients(id) ON DELETE CASCADE,
    code_hash       text NOT NULL UNIQUE CHECK (char_length(code_hash) = 64),
    code_challenge  text NOT NULL CHECK (char_length(code_challenge) BETWEEN 43 AND 128),
    redirect_uri    text NOT NULL,
    admin_id        uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
    connection_name text NOT NULL CHECK (char_length(trim(connection_name)) BETWEEN 1 AND 120),
    capabilities    jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'array'),
    business_ids    jsonb CHECK (business_ids IS NULL OR jsonb_typeof(business_ids) = 'array'),
    -- NULL = the connection never expires on its own (refresh keeps it alive).
    connection_expires_in_days integer CHECK (connection_expires_in_days IS NULL OR connection_expires_in_days BETWEEN 1 AND 3650),
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_mcp_oauth_codes_expiry ON platform_mcp_oauth_codes (expires_at);

-- Access and refresh tokens of an OAuth connection. Hashes only; both kinds in
-- one table because both are revoked by the same act (revoking the connection).
CREATE TABLE platform_mcp_oauth_tokens (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id uuid NOT NULL REFERENCES platform_mcp_connections(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('access', 'refresh')),
    token_hash    text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
    expires_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz
);
CREATE INDEX idx_platform_mcp_oauth_tokens_connection
    ON platform_mcp_oauth_tokens (connection_id, kind, created_at DESC);
CREATE INDEX idx_platform_mcp_oauth_tokens_expiry ON platform_mcp_oauth_tokens (expires_at);
