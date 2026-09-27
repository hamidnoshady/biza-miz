import { NextRequest, NextResponse } from "next/server";
import { activatePairingEnrollment } from "@/lib/pairing-service";

/**
 * Public only in the same constrained sense as pairing redemption: it accepts
 * the freshly generated, hash-only site credential and performs no tenant
 * session lookup. A pending identity cannot push or pull until this succeeds.
 */
export async function POST(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  let body: { siteDeviceId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!token || !body.siteDeviceId?.trim()) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const result = await activatePairingEnrollment(body.siteDeviceId.trim(), token);
  if (!result.ok) {
    const status = result.error === "pairing_not_found" ? 401 : result.error === "pairing_expired" ? 410 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  const response = NextResponse.json({ ok: true, alreadyActive: result.alreadyActive });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
