/**
 * The one wrapper every `/api/integrations/wordpress/*` route uses.
 *
 * Two things here are load-bearing and easy to get wrong if each route did its
 * own:
 *
 *  1. **The body is read exactly once, as text.** The HMAC covers the literal
 *     bytes the plugin signed, so parsing to JSON and re-serialising before
 *     verifying would compare a signature against a different string (key
 *     order, whitespace, number formatting). Verification happens on the raw
 *     text; parsing happens only afterwards.
 *  2. **Authentication precedes everything.** A route body never runs against
 *     an unverified caller, and an authentication failure is answered with a
 *     bare error code and no detail about the connection.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticatePlugin } from "./plugin-service";
import type { ConnectionRow } from "./connections-service";

export type PluginRouteHandler = (
  connection: ConnectionRow,
  body: Record<string, unknown>,
) => Promise<NextResponse>;

/** Bigger than any legitimate batch, small enough that an abusive one is refused before it is parsed. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function pluginRoute(handler: PluginRouteHandler) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const rawBody = await request.text();
    // Bytes, not UTF-16 code units: a Persian catalogue is two bytes a letter,
    // so `.length` would let a body twice the limit through.
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }

    const auth = await authenticatePlugin(request.headers, rawBody);
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.error, ...(auth.serverTime ? { serverTime: auth.serverTime } : {}) },
        { status: auth.status },
      );
    }

    let body: Record<string, unknown> = {};
    if (rawBody.trim()) {
      try {
        const parsed = JSON.parse(rawBody);
        if (parsed && typeof parsed === "object") {
          // A top-level JSON array is accepted as an empty body. PHP's
          // wp_json_encode renders an empty array as `[]`, and plugins older
          // than 1.0.1 send exactly that for calls with no payload (ping,
          // pull-jobs), so rejecting it would keep those plugins dead-ended.
          body = Array.isArray(parsed) ? {} : parsed;
        } else {
          return NextResponse.json({ error: "invalid_json" }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: "invalid_json" }, { status: 400 });
      }
    }

    return handler(auth.connection, body);
  };
}
