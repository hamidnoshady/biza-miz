import { NextRequest, NextResponse } from "next/server";
import { protectedResourceMetadata } from "@/lib/mcp/oauth";
import { mcpIssuer } from "@/lib/mcp/origin";

/**
 * RFC 9728 — protected resource metadata, served at
 * `/.well-known/oauth-protected-resource` (see the rewrites in
 * `next.config.ts`; Next's app router will not serve a dot-prefixed folder).
 *
 * The optional catch-all matters: RFC 9728 tells a client to look for the
 * document at the resource's *path-inserted* location — for a resource at
 * `/api/mcp`, that is `/.well-known/oauth-protected-resource/api/mcp` — while
 * plenty of clients (and every hand-written curl) try the bare path first. Both
 * answer the same document rather than one of them 404ing, because a 404 here is
 * indistinguishable to a client from "this server does not support OAuth", and
 * the connector then silently fails to add.
 *
 * Session-less and public by necessity: this is what a client reads *before* it
 * has any credential. It discloses nothing but URLs that are already implied by
 * the hostname.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
) {
  const issuer = mcpIssuer(request.headers, request.nextUrl.protocol);
  // RFC 9728 §3.1 — the path-inserted form answers for `/api/mcp` equally
  // (one document, whatever path names it), but the platform realm is
  // deliberately not a protected resource: a console-only `pospmcp_` flow
  // with no OAuth handshake should answer no — 404 — instead of lying.
  const { path } = await context.params;
  const inserted = path?.length ? `/${path.join("/")}` : "/api/mcp";
  const document = protectedResourceMetadata(issuer, inserted);
  if (!document) {
    return NextResponse.json({ error: "resource_not_served" }, { status: 404 });
  }
  const response = NextResponse.json(document);
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Cache-Control", "public, max-age=3600");
  return response;
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
    },
  });
}
