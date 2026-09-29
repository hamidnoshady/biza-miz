/**
 * Authentication for the bearer routes a paired desktop calls on the central
 * server that carry more than the legacy push/pull (master data, drift
 * digests, the wake-up long-poll). Each requires a *site device* credential:
 * a legacy business-wide token cannot say which branch or install is calling,
 * and every one of these answers is scoped to exactly that branch.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveSyncCredential } from "./server-sync";

export interface SiteIdentity {
  businessId: string;
  locationId: string;
  siteDeviceId: string;
}

export function bearerToken(request: NextRequest): string {
  const auth = request.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
}

export async function requireSiteCredential(
  request: NextRequest,
): Promise<{ identity: SiteIdentity } | { response: NextResponse }> {
  const bearer = bearerToken(request);
  if (!bearer) return { response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const credential = await resolveSyncCredential(bearer);
  if (!credential?.siteDeviceId || !credential.locationId) {
    return { response: NextResponse.json({ error: "device_credential_required" }, { status: 401 }) };
  }
  return {
    identity: {
      businessId: credential.businessId,
      locationId: credential.locationId,
      siteDeviceId: credential.siteDeviceId,
    },
  };
}
