/**
 * Issue #984 — authentication for the companion-facing routes.
 *
 * Two credentials, two powers:
 *
 * - The support-device credential (provisioned by owner-approved enrollment,
 *   a separate audience from the main app's sync token) unlocks exactly one
 *   thing: polling this installation's own pending requests/sessions
 *   (metadata for the locked welcome screen), plus Stop/consent-revoke. It
 *   confers no execution and no report upload. It works when the main
 *   database is down, which the sync token sealed inside that database
 *   cannot.
 * - The ticket-bound support session JWT (minted by redeeming a support
 *   token) authorises the companion's privileged calls, each re-checked
 *   against the live installation/generation, the issuance revocation state
 *   and the JWT's own operation scope.
 *
 * Scope is always derived server-side from verified credentials — never
 * from request-body business or ticket ids.
 */
import { NextResponse, type NextRequest } from "next/server";
import { withTenant } from "../db";
import { bearerToken } from "../server-sync-auth";
import {
  resolveSupportTokenKeys,
  verifyCompanionSession,
  type VerifiedCompanionSession,
} from "./access-tokens";
import {
  verifySupportDeviceCredential,
  type SupportDeviceIdentity,
} from "./device-credentials";
import { getInstallation, type SupportInstallation } from "./installations";

export async function requireCompanionSession(
  request: NextRequest,
): Promise<{ session: VerifiedCompanionSession } | { response: NextResponse }> {
  const bearer = bearerToken(request);
  if (!bearer) return { response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  let keys;
  try {
    keys = resolveSupportTokenKeys(process.env);
  } catch {
    return { response: NextResponse.json({ error: "signing_unavailable" }, { status: 503 }) };
  }
  const verified = await verifyCompanionSession(bearer, keys);
  if (!verified.ok) {
    const status =
      verified.error === "expired"
        ? 401
        : verified.error === "revoked"
          ? 403
          : verified.error === "installation_not_active" || verified.error === "generation_mismatch"
            ? 403
            : 401;
    return { response: NextResponse.json({ error: `session_${verified.error}` }, { status }) };
  }
  return { session: verified.session };
}

export interface CompanionDevice {
  identity: SupportDeviceIdentity;
  installation: SupportInstallation;
}

export async function requireCompanionDevice(
  request: NextRequest,
): Promise<{ device: CompanionDevice } | { response: NextResponse }> {
  const bearer = bearerToken(request);
  if (!bearer) return { response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const identity = await verifySupportDeviceCredential(bearer);
  // One response for unknown/revoked/expired/unenrolled alike: the caller
  // learns nothing about which credentials exist.
  if (!identity) {
    return { response: NextResponse.json({ error: "installation_not_enrolled" }, { status: 403 }) };
  }
  // The credential is verified, so its businessId is trustworthy — and
  // required: under FORCE RLS the installation row is invisible unscoped.
  const installation = await withTenant(identity.businessId, () =>
    getInstallation(identity.businessId, identity.installationId),
  );
  if (!installation || installation.enrollmentState !== "active") {
    return { response: NextResponse.json({ error: "installation_not_enrolled" }, { status: 403 }) };
  }
  return { device: { identity, installation } };
}
