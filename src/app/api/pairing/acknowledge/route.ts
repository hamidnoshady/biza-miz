import { NextRequest, NextResponse } from "next/server";
import { acknowledgePairingSession } from "@/lib/pairing-service";

/**
 * The desktop calls this only after its local snapshot transaction committed.
 * The pending site credential is the proof; normal server-sync endpoints still
 * reject it until this acknowledgement turns the device active.
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : "";
  if (!token)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { pairingSessionId?: unknown; installationId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (
    typeof body.pairingSessionId !== "string" ||
    typeof body.installationId !== "string" ||
    body.installationId.trim().length < 8 ||
    body.installationId.trim().length > 200
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await acknowledgePairingSession(
    body.pairingSessionId,
    body.installationId.trim(),
    token,
  );
  if (!result.ok) {
    const status =
      result.error === "pairing_session_not_found"
        ? 404
        : result.error === "pairing_session_expired"
          ? 410
          : 403;
    return NextResponse.json({ error: result.error }, { status });
  }
  const response = NextResponse.json(result);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
