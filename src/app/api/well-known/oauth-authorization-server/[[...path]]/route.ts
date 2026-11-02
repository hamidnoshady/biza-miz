import { NextRequest, NextResponse } from "next/server";
import { authorizationServerMetadata } from "@/lib/mcp/oauth";
import { mcpIssuer } from "@/lib/mcp/origin";
import {
  isPlatformAdminHost,
  platformAuthorizationServerMetadata,
  wellKnownIsPlatformRealm,
} from "@/lib/mcp/platform-oauth-docs";

/**
 * RFC 8414 — authorization server metadata, served at
 * `/.well-known/oauth-authorization-server` (rewritten there in
 * `next.config.ts`).
 *
 * Same optional catch-all as the protected-resource document next door, for the
 * same reason: clients differ on whether they append the resource path, and a
 * 404 reads as "no OAuth here".
 *
 * The one field that makes the whole connector work by pasting a URL is
 * `registration_endpoint`. Without dynamic client registration every business
 * would have to pre-register Claude, ChatGPT and every other client by hand
 * before an owner could connect any of them.
 *
 * The console realm (`/api/platform/mcp`) is its own authorization server: its
 * document answers the path-inserted form for the console's resource path, and
 * the bare document on the admin host, where the console is the only realm.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
) {
  const origin = mcpIssuer(request.headers, request.nextUrl.protocol);
  const { path } = await context.params;
  const suffix = path?.length ? `/${path.join("/")}` : "";
  const adminHost = isPlatformAdminHost(request.headers);
  const document = wellKnownIsPlatformRealm(suffix, adminHost)
    ? platformAuthorizationServerMetadata(origin, adminHost)
    : authorizationServerMetadata(origin);
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
