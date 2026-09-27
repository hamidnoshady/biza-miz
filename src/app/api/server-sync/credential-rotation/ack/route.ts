import { NextRequest, NextResponse } from "next/server";
import { resolveSyncCredential } from "@/lib/server-sync";
import { acknowledgeStagedCredential } from "@/lib/site-device-service";
import { withTenant } from "@/lib/db";

/** The desktop proves it installed the staged credential, then promotes it. */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const identity = await resolveSyncCredential(token);
  if (!identity?.siteDeviceId || identity.credentialState !== "staged") {
    return NextResponse.json({ error: "staged_credential_required" }, { status: 409 });
  }
  const acknowledged = await withTenant(identity.businessId, () => acknowledgeStagedCredential(
    identity.businessId,
    identity.siteDeviceId!,
    identity.credentialId,
  ));
  if (!acknowledged) return NextResponse.json({ error: "staged_credential_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
