# Platform MCP client setup (Superadmin → AI client)

> Issue #1126 §A. How an owner connects Claude Code, Claude Desktop, Codex or
> another MCP-speaking client to the **platform** endpoint, and what that
> connection can and cannot do.

## The endpoint

```
https://<platform-public-host>/api/platform/mcp
```

The console page **Superadmin → MCP connections** (`/platform/mcp-connections`)
shows the canonical URL for *this* deployment — copy it from there rather than
typing it. Derivation (`resolvePlatformMcpEndpoint` in
`src/lib/mcp/platform-client-config.ts`):

| Deployment | Canonical origin | Notes |
| --- | --- | --- |
| Host routing on (`ROOT_DOMAIN` set) | `https://admin.{root}` | The console lives on the admin host and nowhere else; middleware 307s every other host there, and a 307 does not carry an `Authorization` header. A request arriving on a tenant host, the apex, or an unknown host gets the admin origin with a warning naming the substitution. A tenant host is **never** advertised. |
| Routing off (single-origin install, desktop) | The request's own origin | Same "ask the host" rule as the tenant endpoint and desktop pairing. `PLATFORM_BASE_URL` is only a fallback when the request carries no host at all. |

`PLATFORM_BASE_URL` deliberately does **not** override a live origin: it names
the apex/central base, and advertising the apex for an endpoint served only on
the admin host would hand every client a redirect.

## Authentication: OAuth sign-in, or a pasted bearer token

The console realm accepts two credentials on the same URL, both sent as
`Authorization: Bearer …`:

1. **OAuth 2.1 (recommended for Claude.ai, ChatGPT, Claude Code `/mcp`).** Paste
   only the endpoint. The client reads the `401`'s `WWW-Authenticate` header,
   follows it to `/.well-known/oauth-protected-resource/api/platform/mcp`,
   registers itself (RFC 7591) and sends the admin to
   `/platform/mcp-connections/consent`. Only a platform **owner** (`admins.manage`)
   can approve; the admin ticks the capabilities, optionally limits the
   businesses and picks an expiry. Tokens are `pospmcp_at_…` (12 h, refreshed
   with a rotating `pospmcp_rt_…`, PKCE S256 only). The connection appears in
   the console list with origin «OAuth» and is revoked the same way as any other.
2. **A pasted `pospmcp_` token** minted from the console. Unchanged.

Discovery: on the admin host the bare `/.well-known/oauth-authorization-server`
answers for the console; on a single-origin install the console's documents are
the path-inserted `…/oauth-authorization-server/api/platform/mcp` forms, and the
bare documents stay the tenant's.

Consequences:

- A **tenant token (`posmcp_…`) never works here**, and a platform token never
  works at a tenant's `/api/mcp`. The families differ at the fourth character
  and each side rejects the other on shape, before any lookup. The OAuth clients,
  codes and tokens live in their own tables (migration 0258).
- A dead token answers HTTP **401** with `error="invalid_token"` (and the
  JSON-RPC `-32004` body), so an OAuth client knows to refresh or re-authorize.
- A pasted token is shown **once**, at minting. It is stored as a SHA-256 hash and
  cannot be recovered. If it is lost or leaked: revoke the connection (cut on
  its very next call), mint a new token, and update the client config.
- Never put a token in a URL, a log, or chat: header or client env var only.

## Client configurations

All examples use the server name `biza-miz-superadmin`. The console page
generates them with the real endpoint and — only in the one-time issuance
panel — with the real token.

### Claude Code and other direct-HTTP clients — `.mcp.json`

```json
{
  "mcpServers": {
    "biza-miz-superadmin": {
      "type": "http",
      "url": "https://YOUR-PLATFORM-HOST/api/platform/mcp",
      "headers": { "Authorization": "Bearer pospmcp_REPLACE_WITH_YOUR_TOKEN" }
    }
  }
}
```

For any client that accepts a streamable-HTTP URL plus custom headers.

### Claude Desktop — `claude_desktop_config.json` via `mcp-remote`

Desktop only accepts `command` (stdio) servers and rejects the direct-HTTP
object as invalid, so bridge through `mcp-remote` (requires Node.js):

```json
{
  "mcpServers": {
    "biza-miz-superadmin": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://YOUR-PLATFORM-HOST/api/platform/mcp",
        "--header", "Authorization:${AUTH_HEADER}"
      ],
      "env": { "AUTH_HEADER": "Bearer pospmcp_REPLACE_WITH_YOUR_TOKEN" }
    }
  }
}
```

### Codex — `~/.codex/config.toml` (TOML, not JSON)

Codex reads TOML tables; pasting JSON is the most common failure. The `url`
key selects streamable-HTTP transport, and `bearer_token_env_var` names the
variable Codex reads at connect time (never put the token in the file):

```toml
[mcp_servers.biza-miz-superadmin]
url = "https://YOUR-PLATFORM-HOST/api/platform/mcp"
bearer_token_env_var = "BIZAMIZ_SUPERADMIN_MCP_TOKEN"
```

```sh
export BIZAMIZ_SUPERADMIN_MCP_TOKEN="pospmcp_REPLACE_WITH_YOUR_TOKEN"
```

Restart Codex and verify with `codex mcp list`. Equivalent one-liner:

```sh
codex mcp add biza-miz-superadmin --url "https://YOUR-PLATFORM-HOST/api/platform/mcp" --bearer-token-env-var BIZAMIZ_SUPERADMIN_MCP_TOKEN
```

### Anything else

A client that speaks MCP streamable HTTP with an `Authorization` header can
`POST` JSON-RPC (`initialize`, `tools/list`, `tools/call`, `ping`) to the
endpoint. Legacy SSE and direct stdio are **not** supported. Config formats
are not universal: when in doubt, translate the three facts above (URL,
bearer header, server name) into the client's own schema.

## What a connected client sees

`tools/list` returns exactly the intersection of:

```
minted capabilities ∩ minter's CURRENT role ∩ (per-call business scope)
```

- A role demotion (or deactivation) takes tools away on the **next call** —
  the catalogue is re-evaluated live, never frozen at mint time.
- Bridged tools always require an explicit `businessId`; a token scoped to a
  business list is refused outside it, per business, with per-business
  outcomes — never a silent widening to "all".
- Every call, including denials, writes one `platform_audit_log` row keyed on
  the connection.

The console's **Test connection** action runs the same handshake an external
client performs (`initialize` + `tools/list`) after a precise,
session-authenticated diagnosis, and reports success, wrong-realm,
expired/revoked/unknown, role-reduced, proxy-stripped-auth, and
network/transport failures distinctly.

## Proxy / CDN notes

- Pass `Authorization` through untouched. A 401 to a client that *sent* a
  bearer means the header was stripped upstream.
- Do not rewrite `/api/platform/mcp` to another path or host; the route only
  answers JSON-RPC `POST` (plus a 405 guidance `GET`).
- The endpoint is rate-limited per credential (shared MCP bucket, 240/min).
- On a `site` (non-central) runtime the whole platform realm 404s, including
  this endpoint — by design.

## What this is not (§B is separate)

Minting an external token makes Biza Miz a **server** for third-party AI
clients. It does **not** attach that server — or any MCP server — as a tool
provider to Biza Miz's own Superadmin-created system agents, which keep using
only the native tool catalogue under their allowlist intersection
(`src/lib/ai-system-agents.ts`). Wiring an external MCP provider into an
agent (registration, discovery, egress policy, approvals) is the separate §B
follow-up; shipping §A must not be presented as completing it.

## Related

- #883 / #904 — the MCP servers themselves (tenant + platform realms)
- #812 — Superadmin system agents (native tools only)
- #757 — retired LiteLLM MCP config cleanup (do not resurrect `mcpEnabled` /
  `mcpServers` gateway fields; pinned by `ai-gateway.test.ts`)
