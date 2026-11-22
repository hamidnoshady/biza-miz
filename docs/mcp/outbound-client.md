# Outbound MCP client (Bizamiz as a client)

This is the opposite direction from [`Phase-34-MCP-Connector.md`](../phases/Phase-34-MCP-Connector.md):
there Bizamiz **serves** tools to ChatGPT/Claude; here Bizamiz **calls** somebody
else's MCP server — an Eshobe CMS, a search index, a translation service.

The two live apart on purpose. `src/lib/mcp/server.ts` mints and checks `posmcp_`
credentials; `src/lib/mcp/outbound/*` holds a bearer token for somebody else's
server. A module that does both is one bug away from being a proxy, and a proxy is
what an attacker wants: the SSRF guard below assumes the egress path is only ever
reached with a URL an operator named.

## What exists today

| Piece | File | State |
| --- | --- | --- |
| URL + DNS policy (SSRF guard) | `src/lib/mcp/outbound/guard.ts` | done, 49 tests |
| Streamable HTTP JSON-RPC client | `src/lib/mcp/outbound/client.ts` | done, 15 tests |
| Registry table, encryption, admin API | — | **not implemented** |
| Agent tool wiring (expose discovered tools to a turn) | — | **not implemented** |
| Execution audit | — | **not implemented** |

64 unit tests, `npx vitest run src/lib/mcp/outbound`.

## Using the client

```ts
import { OutboundMcpClient } from "@/lib/mcp/outbound/client";
import { outboundPolicyFromEnv } from "@/lib/mcp/outbound/guard";

const client = new OutboundMcpClient({
  url: server.url,                 // https, host must be allowlisted
  bearerToken: decryptedSecret,    // null for an unauthenticated server
  timeoutMs: 15_000,
  policy: outboundPolicyFromEnv(),
});

const info = await client.initialize();     // protocol + server self-description
const tools = await client.listTools();     // JSON Schema, passed through untouched
const result = await client.callTool("findPages", { limit: 5 });
```

`callTool` returns the MCP result as sent — `content`, `isError`,
`structuredContent`. A refused operation from a well-behaved server arrives as
`isError: true` with HTTP 200, so callers must inspect both the transport outcome
and the payload.

## Configuration

| Variable | Meaning |
| --- | --- |
| `MCP_OUTBOUND_ALLOWED_HOSTS` | Comma-separated `host` or `host:port` allowlist. **Empty refuses every outbound MCP call.** A bare host means the default HTTPS port only. |
| `MCP_OUTBOUND_ALLOW_LOOPBACK_HTTP` | `true` permits `http://` for an explicitly allowlisted loopback entry (`localhost:4010`). Development only. |

Both are read per request, not at module load, so a policy change needs no restart
of a long-lived process and a test can set them.

## Threat model

The guard is layered, and each layer exists because the one before it is
insufficient:

1. **Allowlist by host.** Nothing is resolved or contacted unless the operator named
   the host. This is what makes DNS rebinding uninteresting, and it is why the
   allowlist is configuration rather than a column a request can influence.
2. **Literal addresses refused.** `https://127.0.0.1/`, `https://[::1]/` and
   `https://169.254.169.254/` never reach the network, allowlisted or not.
3. **Every resolved address checked.** `lookup(all: true)`, and *any* private answer
   refuses the whole request — a hostile name commonly returns one public and one
   private record.
4. **No redirects.** `redirect: "error"`. One 302 from an allowed host to the
   metadata service would otherwise walk past layers 1–3.
5. **No URL credentials, no fragments, scheme pinned to HTTPS.** `https://user:pass@host`
   is a secret in a string that ends up in logs.
6. **Bounded work.** 15 s default timeout, 512 KiB default response cap (declared
   `Content-Length` checked before reading, actual bytes after), 250 tools, 10
   pagination pages.

Residual risk, stated rather than hidden: layer 3 resolves the name and the client
resolves it again when it connects, so a TTL-0 record that flips in between can
still win a race. Layer 1 is the mitigation — the name has to be one the operator
chose — and it is why the allowlist is not optional.

Error messages come from a closed set plus a truncated server sentence. Status
codes, RPC codes and the origin may appear; the bearer token, request headers and
response bodies never do, because a transport error is logged far more often than
it is read.

## What the rest of the work needs

The remaining half is a product surface, and it must be built inside this repo's
existing shapes rather than beside them.

1. **Table** `mcp_external_servers` (tenant table, forced RLS like every other):
   `business_id`, `slug`, `label`, `url`, `auth_kind` (`none` | `bearer`),
   `bearer_token_enc bytea` (POSFLD1 envelope, business DEK — register the column in
   `encrypted-columns.ts`), `enabled`, `allowed_tools text[]` (empty = all discovered),
   `last_discovered_at`, `last_error`, timestamps. Add to `TENANT_TABLES`.
2. **Service** `src/lib/mcp/outbound/service.ts`: CRUD, credential encryption via
   `field-crypto`, discovery cache, `callExternalTool` that opens a client, calls,
   and records an audit row. The credential is write-only over the API and never
   returned.
3. **Admin surface**: a panel beside the existing MCP connections tab —
   url, credential, "test connection" (runs `initialize` + `tools/list` and shows
   the negotiated protocol and tool count), enable/disable, allowlist of discovered
   tools. Seeds from `MCP_OUTBOUND_ALLOWED_HOSTS`, never overrides it.
4. **Agent wiring** — the part that needs the approval `ai-system-agents.ts`
   records. External tools must enter the *same* intersection, never a parallel one:
   - a permission key (for example `ai.externalTools.use`) added to
     `AI_TOOL_PERMISSION_MAP` semantics, so `filterAiToolsByPermissions` still drops
     anything unregistered;
   - tool names namespaced per server (`mcp_<serverSlug>__<tool>`) and only for
     servers the tenant enabled *and* the agent's `allowed_tools` names;
   - dispatch in `runReadTool` that re-checks permission, re-checks the server is
     enabled for this business, calls the client, and returns `ToolResult`.
5. **Audit**: one row per external call — server, tool, status, duration, truncated
   error. Never arguments or results in full: a CMS tool can return a customer's
   data, and an audit trail is not a second copy of the tenant's database.
6. **Docs**: extend this file with the operator guide and the agent example.

Until 1–5 exist, a tenant cannot register a server and an agent cannot call one.
The transport being finished does not make the feature available, and nothing in the
UI or the catalogue should imply otherwise.

## Why the direction is explicit

`Phase-34` deliberately made "mint a credential" and "attach a tool provider" two
different acts: a `pospmcp_` token exposes Bizamiz's server to a client, and it
cannot cause Bizamiz to start calling out. Keeping that invariant means the inbound
credential and the outbound registry share no table, no service and no route.
