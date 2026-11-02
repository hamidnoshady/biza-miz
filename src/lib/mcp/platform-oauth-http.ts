/**
 * Shared HTTP plumbing for the console realm's OAuth endpoints — CORS and the
 * two body encodings clients send. Bearer/PKCE only, never a cookie, which is
 * exactly the condition under which a wildcard origin is safe (the same
 * reasoning as the tenant realm's endpoints).
 */
import { NextRequest, NextResponse } from "next/server";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
};

export function platformOauthCors(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export function platformOauthPreflight(): NextResponse {
  return platformOauthCors(new NextResponse(null, { status: 204 }));
}

export function platformOauthError(error: string, description: string, status = 400): NextResponse {
  return platformOauthCors(NextResponse.json({ error, error_description: description }, { status }));
}

/** Accepts `application/x-www-form-urlencoded` (RFC 6749) and JSON — several MCP clients send JSON. */
export async function readPlatformOauthParams(request: NextRequest): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(body).map(([key, value]) => [key, typeof value === "string" ? value : String(value ?? "")]),
      );
    } catch {
      return {};
    }
  }
  try {
    const form = await request.formData();
    const params: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") params[key] = value;
    }
    return params;
  } catch {
    return {};
  }
}
