import { NextRequest, NextResponse } from "next/server";
import { revokePlatformMcpOauthToken } from "@/lib/mcp/platform-oauth";
import { platformOauthCors, platformOauthPreflight, readPlatformOauthParams } from "@/lib/mcp/platform-oauth-http";
import { platformRealmUnavailable } from "@/lib/platform-runtime-guard";

/**
 * RFC 7009 — hand a token back. Always answers 200, even for a token that never
 * existed: the endpoint is unauthenticated, so a truthful "no such token" would
 * be an oracle for guessed credentials. Revokes one token, not the connection;
 * removing the connection is the console's «لغو» on the connections page.
 */
export async function OPTIONS() {
  return platformOauthPreflight();
}

export async function POST(request: NextRequest) {
  // Issue #1194 — the Central realm does not exist on a site runtime. Deny
  // before reading any credential, so a local install cannot even begin a
  // platform sign-in or MCP grant.
  const realmUnavailable = platformRealmUnavailable();
  if (realmUnavailable) return realmUnavailable;
  const params = await readPlatformOauthParams(request);
  if (params.token) await revokePlatformMcpOauthToken(params.token);
  return platformOauthCors(new NextResponse(null, { status: 200 }));
}
