import { NextRequest, NextResponse } from "next/server";
import { dispatchMcpMessage } from "@/lib/mcp/server";
import { withMcpScope } from "@/lib/mcp/auth";
import { bearerChallenge } from "@/lib/mcp/oauth";
import { mcpIssuer } from "@/lib/mcp/origin";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { resolveCapability } from "@/lib/capabilities";
import {
  JSON_RPC_ERRORS,
  LATEST_PROTOCOL_VERSION,
  jsonRpcError,
  parseBody,
  type JsonRpcResponse,
} from "@/lib/mcp/protocol";

/**
 * Phase 34 — the MCP endpoint itself.
 *
 * One URL, the Streamable HTTP transport, no session state. A client POSTs a
 * JSON-RPC message (or a batch of them) with a bearer token; it gets one JSON
 * response back. There is no SSE stream and no `Mcp-Session-Id`, because every
 * method this server implements is request/response and nothing is ever pushed
 * — so a stream would be a resource to keep alive, resume and expire in exchange
 * for behaviour nobody could observe. `GET` therefore refuses, which is the
 * documented way to say "this server offers no stream".
 *
 * The 401 is the load-bearing part of the whole feature. A client that has never
 * seen this business before arrives with no credential, reads
 * `WWW-Authenticate`, follows it to the protected-resource metadata, finds the
 * authorization server, registers itself and starts the OAuth flow — which is
 * the entire reason an owner can add this connector by pasting one URL into
 * Claude on their phone. Dropping that header does not break a test; it breaks
 * discovery, silently, in a client that shows no error.
 */

/**
 * The MCP realm answers cross-origin callers on purpose: a browser-based client
 * (ChatGPT's connector UI, a web MCP inspector) must be able to reach it, and
 * nothing here is cookie-authenticated — every request carries a bearer token,
 * so there is no ambient authority for a hostile page to ride. That is exactly
 * the condition under which a wildcard origin is safe, and `credentials` is
 * never allowed.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

function withCors(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
  // A bearer-authenticated answer about one business's takings is never
  // cacheable by anything in between.
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function unauthorized(request: NextRequest): NextResponse {
  const issuer = mcpIssuer(request.headers, request.nextUrl.protocol);
  const response = NextResponse.json({ error: "unauthorized" }, { status: 401 });
  response.headers.set("WWW-Authenticate", bearerChallenge(issuer));
  return withCors(response);
}

export async function OPTIONS() {
  return withCors(new NextResponse(null, { status: 204 }));
}

export async function GET(request: NextRequest) {
  const response = NextResponse.json(
    { error: "sse_not_supported", detail: "This MCP server answers POST only." },
    { status: 405 },
  );
  response.headers.set("Allow", "POST, DELETE, OPTIONS");
  void request;
  return withCors(response);
}

/** Session termination. There is no session to terminate, so this is a clean no-op. */
export async function DELETE() {
  return withCors(new NextResponse(null, { status: 204 }));
}

/**
 * P1-9's hard ceiling. A CMS-sized body is tens of kilobytes; the largest
 * legitimate frame (one write with a long Persian memo, or the tools/list
 * answer's echo) is nowhere near a megabyte. Read as text so the byte count
 * is checked *before* the JSON parser pays for the whole allocation.
 */
const MAX_BODY_BYTES = 1024 * 1024;

export async function POST(request: NextRequest) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return withCors(
      NextResponse.json(
        jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, "درخواست بیش از حد بزرگ است"),
        { status: 413 },
      ),
    );
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return withCors(
        NextResponse.json(
          jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, "درخواست بیش از حد بزرگ است"),
          { status: 413 },
        ),
      );
    }
    body = JSON.parse(text);
  } catch {
    return withCors(
      NextResponse.json(jsonRpcError(null, JSON_RPC_ERRORS.parseError, "بدنهٔ JSON نامعتبر است"), {
        status: 400,
      }),
    );
  }

  const parsed = parseBody(body);
  if (!parsed) {
    return withCors(
      NextResponse.json(jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, "درخواست خالی یا نامعتبر است"), {
        status: 400,
      }),
    );
  }

  const outcome = await withMcpScope(request, async (auth) => {
    // MCP is bearer-authenticated and bypasses withTenantScope, so it must
    // enforce deployment policy after its token resolves the business. This
    // closes the otherwise-valid-token bypass on a fully Local installation.
    const deployment = await readDeploymentProfile(auth.businessId);
    if (!resolveCapability("app.ai", { deployment: deployment.profile }).available) {
      return { deploymentBlocked: true, responses: [] as JsonRpcResponse[] };
    }
    const responses: JsonRpcResponse[] = [];
    // Sequential, not Promise.all: a batch that mixes two writes must not
    // interleave them, and MCP clients send batches of at most a few messages.
    for (const message of parsed.messages) {
      const response = await dispatchMcpMessage(auth, message);
      if (response) responses.push(response);
    }
    return { deploymentBlocked: false, responses };
  });

  if (!outcome.ok) {
    if (outcome.error === "unauthorized") return unauthorized(request);
    return withCors(
      NextResponse.json(
        {
          error: "feature_disabled",
          detail: "این کسب‌وکار به «کلیدهای API و اتصال هوش مصنوعی» دسترسی ندارد.",
        },
        { status: 403 },
      ),
    );
  }

  if (outcome.value.deploymentBlocked) {
    return withCors(NextResponse.json({
      error: "capability_unavailable",
      code: "REQUIRES_CLOUD_CONNECTION",
      capability: "app.ai",
      status: "requires_cloud",
    }, { status: 403 }));
  }

  const responses = outcome.value.responses;
  // A body of notifications only: nothing to answer, and 202 is what the spec
  // asks for rather than an empty 200 body a client would try to parse.
  if (responses.length === 0) return withCors(new NextResponse(null, { status: 202 }));

  const payload = parsed.batch ? responses : responses[0];
  const response = NextResponse.json(payload);
  response.headers.set("MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);
  return withCors(response);
}
