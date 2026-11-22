# Outbound MCP client (Bizamiz as a client)

This is the opposite direction from [`Phase-34-MCP-Connector.md`](../phases/Phase-34-MCP-Connector.md):
there Bizamiz **serves** tools to ChatGPT/Claude; here Bizamiz **calls** somebody
else's MCP server — an Eshobe CMS, a search index, a translation service.

The two live apart on purpose. `src/lib/mcp/server.ts` mints and checks `posmcp_`
credentials; `src/lib/mcp/outbound/*` holds a bearer token for somebody else's
server. A module that does both is one bug away from being a proxy, and a proxy is
what an attacker wants: the SSRF guard below assumes the egress path is only ever
reached with a URL an operator named.

Implemented for issue #1473 (the second half of #1126 §B).

## What exists

| Piece | File | State |
| --- | --- | --- |
| URL + DNS policy (SSRF guard) | `src/lib/mcp/outbound/guard.ts` | done — 49 tests |
| Streamable HTTP JSON-RPC client | `src/lib/mcp/outbound/client.ts` | done — 15 tests |
| Tool-name mapping | `src/lib/mcp/outbound/naming.ts` | done |
| Registry, credential encryption, discovery, invocation, audit | `src/lib/mcp/outbound/service.ts` | done |
| Tenant tables + RLS | `migrations/0313_mcp_external_servers.sql` | done, `up` verified on a full migration run |
| Management API | `src/app/api/integrations/mcp-servers/**` | done |
| Panel | `src/app/(app)/settings/connections/external-mcp-panel.tsx` | done, in the MCP tab |
| Agent wiring | `src/lib/ai-service.ts`, `src/lib/ai-tools.ts`, `src/lib/ai-capabilities.ts` | done |
| Execution audit | `mcp_external_calls` | done |

Tests: 76 unit (`src/lib/mcp/outbound`, `src/lib/ai-external-tools.test.ts`), 8
integration (`integration/mcp-outbound.integration.test.ts`), plus the existing
`tenant-isolation` suite which now also covers the two new tables.

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

const info = await client.initialize();
const tools = await client.listTools();
const result = await client.callTool("findPages", { limit: 5 });
```

Applications use the service layer instead of the client directly:
`createExternalMcpServer`, `discoverExternalMcpServer`, `externalToolsForTurn`,
`callExternalMcpTool`.

## Configuration

| Variable | Meaning |
| --- | --- |
| `MCP_OUTBOUND_ALLOWED_HOSTS` | Comma-separated `host` or `host:port` allowlist. **Empty refuses every outbound MCP call.** A bare host means the default HTTPS port only. |
| `MCP_OUTBOUND_ALLOW_LOOPBACK_HTTP` | `true` permits `http://` for an explicitly allowlisted loopback entry. Development only. |
| `INTEGRATIONS_ENCRYPTION_KEY` | 64 hex characters; the key the bearer credential is encrypted under. Falls back to `JWT_SECRET` (SHA-256) as the WooCommerce and AI-gateway credentials do. Rotating it orphans stored ciphertexts — re-enter them. |

All three are read per call. A policy change needs no restart of a long-running
process, and an existing row cannot outrun the allowlist.

## Operator flow

1. **Connections → MCP → «سرورهای MCP خارجی»**.
2. Fill in a slug (`acme-cms`), a label, the server URL and, if the server requires
   one, its bearer key. The key is written once and never returned.
3. **تست اتصال** — runs `initialize` + `tools/list`, stores the discovered tools and
   shows the count. A failure is recorded on the row as `lastError` (bounded, no
   credential) so the next person sees why.
4. Optionally untick tools. An empty selection means "every discovered tool"; the
   first untick turns it into an explicit set.
5. Enable the server. Only then does its tool list reach a model turn.

For an Eshobe CMS:

- URL: `https://<cms-control-plane-host>/api/mcp`
- Key: an MCP key minted there (**یکپارچه‌سازی → کلیدهای MCP**), whose owner is a
  member of the site the assistant should act on.
- The host must be in `MCP_OUTBOUND_ALLOWED_HOSTS`.

## How a call is authorised

Three independent gates, all re-evaluated at call time:

1. `ai.use` — `canUseAiTool` recognises the `mcp_` prefix and requires the assistant
   permission; a member without it never sees the tool in a turn.
2. The **server row** — enabled, still present, and its URL still passes the guard.
3. The **per-tool allowlist** — empty means all discovered, otherwise the remote
   tool must be named.

The agent's own `allowed_tools` narrows the catalogue a turn is built from, and the
tenant/app/permission intersection in `runAgentTurn` applies exactly as it does to a
built-in tool. There is no second catalogue and no bypass flag.

Inbound MCP connections (`/api/mcp` server) never see outbound tools: `src/lib/mcp/tools.ts`
builds its catalogue from Bizamiz's own tools only, so a third-party client cannot
relay through Bizamiz to another server.

## Threat model

1. **Allowlist by host.** Nothing is resolved or contacted unless the operator named
   the host. This is what makes DNS rebinding uninteresting.
2. **Literal addresses refused.** `https://127.0.0.1/`, `https://[::1]/` and
   `https://169.254.169.254/` never reach the network, allowlisted or not.
3. **Every resolved address checked.** `lookup(all: true)`; any private answer
   refuses the whole request.
4. **No redirects.** `redirect: "error"`.
5. **No URL credentials, no fragments, HTTPS-only** (loopback HTTP behind the dev
   flag).
6. **Bounded work.** 15 s timeout, 512 KiB response cap, 250 tools, 10 pages.
7. **Credential never returned.** Encrypted at rest (`v1.<iv>.<ciphertext>.<tag>`),
   absent from every read shape, and never copied into an error, an audit row or a
   log line.

Residual risk, stated rather than hidden: resolve-then-connect is a TOCTOU window
and the allowlist is the mitigation. Layer 1 is not optional.

## Audit

`mcp_external_calls` gets one row per invocation: server, tool, `ok` / `refused` /
`failed`, duration, error code. Deliberately **no arguments and no result** — an
external CMS tool can return a customer's record, and an audit trail is not a second
copy of the tenant's data. `refused` (the server answered and said no) is separate
from `failed` (transport) because only one of the two is worth retrying.

## Deliberately out of scope

- **OAuth to external servers.** A bearer key covers the CMS case; OAuth is a
  decision for when a server that requires it exists.
- **Automatic execution.** External tools are ordinary read tools: the model asks,
  the dispatcher calls, the result comes back into the turn.
- **An outbound client in `eshobe-cms`.** The CMS side is the server; it has no
  requirement to dial out, and its own allowlist/credential store would be a second
  egress path to secure.
