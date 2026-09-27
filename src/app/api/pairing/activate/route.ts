import { NextRequest, NextResponse } from "next/server";
import { acknowledgePairingSession } from "@/lib/pairing-service";

/**
 * Compatibility alias for desktop builds that called activation by this name.
 * Pairing sessions bind the acknowledgement to the installed backend identity.
 */
export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  let body: { pairingSessionId?: unknown; installationId?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  if (!token || typeof body.pairingSessionId !== "string" || typeof body.installationId !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await acknowledgePairingSession(body.pairingSessionId, body.installationId, token);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.error === "pairing_session_expired" ? 410 : 403 });
  const response = NextResponse.json({ ok: true, alreadyActive: result.state === "completed" });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
