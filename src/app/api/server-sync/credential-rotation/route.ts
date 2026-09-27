import { NextRequest, NextResponse } from "next/server";
import { resolveSyncCredential } from "@/lib/server-sync";
import { stagedCredentialForDevice } from "@/lib/site-device-service";
import { withTenant } from "@/lib/db";

/**
 * Machine-to-machine credential hand-off. This is not an owner credential
 * screen: only the currently active device credential can receive the staged
 * replacement, and the response is never cacheable.
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const identity = await resolveSyncCredential(token);
  if (!identity?.siteDeviceId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const staged = await withTenant(identity.businessId, () => stagedCredentialForDevice(
    identity.businessId,
    identity.siteDeviceId!,
    identity.credentialState,
  ));
  const response = NextResponse.json(staged
    ? { pending: true, token: staged.token }
    : { pending: identity.credentialState === "staged" });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
