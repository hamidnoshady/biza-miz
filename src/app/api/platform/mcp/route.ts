import { NextRequest, NextResponse } from "next/server";
import {
  jsonRpcError,
  jsonRpcResult,
  parseBody,
  negotiateProtocolVersion,
  initializeResult,
  toolResult,
  JSON_RPC_ERRORS,
  MCP_SERVER_NAME,
} from "@/lib/mcp/protocol";
import {
  authenticatePlatformMcp,
  callPlatformMcpTool,
  platformMcpToolCatalogue,
} from "@/lib/mcp/platform-mcp";
import { runInTenantScope } from "@/lib/tenant-context";

export const maxDuration = 60;

/**
 * The console-equivalent of `withMcpScope`: bearer's own authentication is the
 * whole credential and the handler's authority must be the platform bypass —
 * so establish it here without touching cookies (a machine client sends none),
 * which also keeps the handler callable in tests.
 */
function withPlatformMcpScope<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return (...args) => runInTenantScope({ kind: "bypass", reason: "platform-mcp" }, () => handler(...args));
}

/**
 * Issue #883 wave 3 — the Superadmin console's MCP endpoint.
 *
 * A deliberately minimal JSON-RPC surface (`tools/list`, `tools/call`,
 * `ping`, `initialize`): console admins attach an AI client to the SAME
 * business-directory/lifecycle operations the console UI already exposes,
 * under per-tool capability checks that re-verify the admin's CURRENT role
 * on every call.
 *
 * Realm separation from the tenant /api/mcp endpoint is by construction:
 *   - different url, different bearer family (`pospmcp_` vs `posmcp_`), and
 *   - the tenant connectors' metadata (RFC 8414/8707) is not advertised here,
 *   - and business-id targets are always explicit (no ambient "current
 *     tenant" could ever leak in through a session).
 *
 * No cookie/session here: the credential is the full authentication.
 * Consented beginning of the handshake behaves identically to tenants'.
 */
export const POST = withPlatformMcpScope(async (request: NextRequest) => {
  const bearer = request.headers.get("authorization") ?? "";
  const rawToken = bearer.startsWith("Bearer ") ? bearer.slice("Bearer ".length).trim() : "";
  if (!rawToken) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: JSON_RPC_ERRORS.invalidRequest, message: "A platform MCP token is required." } },
      { status: 401, headers: { "www-authenticate": "Bearer realm=platform-mcp" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: JSON_RPC_ERRORS.parseError, message: "Body is not JSON." } },
      { status: 400 },
    );
  }
  const parsed = parseBody(body);
  if (!parsed || parsed.messages.some((m) => m.kind === "invalid")) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: JSON_RPC_ERRORS.invalidRequest, message: "Not a JSON-RPC message." } },
      { status: 400 },
    );
  }

  const auth = await authenticatePlatformMcp(rawToken);
  // Use the catalogue the credential can see for every response — bargaining
  // by granting authority is the whole point of the credential.
  const responses = await Promise.all(
    parsed.messages.map(async (message) => {
      if (message.kind === "invalid") {
        return jsonRpcError(message.id, JSON_RPC_ERRORS.invalidRequest, "Not a JSON-RPC message.");
      }
      if (message.kind === "notification") return null;
      if (!auth) {
        return jsonRpcError(message.id, -32004, "Invalid, expired or revoked platform MCP token.");
      }
      const params = message.params;
      switch (message.method) {
        case "initialize": {
          const tools = platformMcpToolCatalogue(auth);
          return jsonRpcResult(message.id, {
            ...initializeResult({
              title: "Platform console",
              version: "0.3.0",
              protocolVersion: negotiateProtocolVersion(params.protocolVersion),
              instructions:
              "You are the platform-console assistant for this deployment. You see only the tools this " +
              `credential's capabilities allow (${tools.length.toLocaleString("en-US")} visible). ` +
              "Every call is audited against the admin who minted the credential; a tool that bridges into " +
              "a tenant always names that business explicitly, reports a per-business outcome, and can be " +
              "scoped at minting time to a fixed list of businesses.",
            }),
            tools: tools.map((t) => ({ name: t.name, description: t.description })),
          });
        }
        case "notifications/initialized":
        case "notifications/cancelled":
          return null;
        case "ping":
          return jsonRpcResult(message.id, {});
        case "tools/list": {
          const tools = platformMcpToolCatalogue(auth).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }));
          return jsonRpcResult(message.id, { tools });
        }
        case "tools/call": {
          const name = String(params.name ?? "");
          const result = await callPlatformMcpTool(auth, name, (params.arguments ?? {}) as never);
          // Structured data as-is; a denial or message surfaces under `result`.
          const bundled = result.data ?? { result: result.text };
          return jsonRpcResult(message.id, toolResult(bundled, false));
        }
        case "resources/list":
        case "resources/templates/list":
          return jsonRpcResult(message.id, { [message.method === "resources/list" ? "resources" : "resourceTemplates"]: [] });
        case "prompts/list":
          return jsonRpcResult(message.id, { prompts: [] });
        default:
          return jsonRpcError(message.id, JSON_RPC_ERRORS.methodNotFound, `Unknown method '${message.method}'.`);
      }
    }),
  );

  const present = responses.filter((r) => r !== null);
  if (present.length === 0) return new NextResponse(null, { status: 202 });
  return NextResponse.json(parsed.batch ? present : present[0]);
});

/** GET/DELETE exist only to guide clients to the right protocol — the MCP
 * streamable-HTTP spec hands pre-flight clients a plain URL probe. */
export const GET = withPlatformMcpScope(async () =>
  NextResponse.json(
    { error: "method_not_allowed", hint: "This endpoint speaks JSON-RPC over POST." },
    { status: 405, headers: { allow: "POST" } },
  ),
);
