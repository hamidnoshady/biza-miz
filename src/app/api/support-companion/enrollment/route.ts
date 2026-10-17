import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import {
  completeEnrollment,
  confirmSupportDeviceRotation,
  rotateSupportDeviceCredential,
  verifySupportDeviceCredential,
} from "@/lib/support-companion/device-credentials";
import { recordInstallationContact } from "@/lib/support-companion/installations";

/**
 * The companion's side of owner-approved enrollment, plus credential
 * rotation. `complete` is intentionally pre-session: the owner-transferred
 * claim code (single-use, 30-minute expiry, 5-attempt lock) is the
 * credential, in the same pairing shape as `/api/pairing/redeem`, and the
 * path shares middleware's pre-session per-IP bucket. The companion's secret
 * travels once over TLS and is stored hash-only.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "complete") {
    const enrollmentId = typeof body.enrollmentId === "string" ? body.enrollmentId : "";
    const claimCode = typeof body.claimCode === "string" ? body.claimCode : "";
    const credential = typeof body.credential === "string" ? body.credential : "";
    if (!enrollmentId || !claimCode || !credential) {
      return NextResponse.json({ error: "enrollment_claim_and_credential_required" }, { status: 400 });
    }
    const installation =
      body.installation && typeof body.installation === "object"
        ? (body.installation as Record<string, unknown>)
        : {};
    const completed = await completeEnrollment({
      enrollmentId,
      claimCode,
      credential,
      installation: {
        displayName: typeof installation.displayName === "string" ? installation.displayName : undefined,
        osBuild: typeof installation.osBuild === "string" ? installation.osBuild : null,
        companionVersion:
          typeof installation.companionVersion === "string" ? installation.companionVersion : null,
      },
    });
    if (!completed.ok) {
      const status =
        completed.error === "credential_rejected"
          ? 400
          : completed.error === "claim_rejected"
            ? 403
            : completed.error === "enrollment_expired"
              ? 410
              : 404;
      return NextResponse.json({ error: completed.error }, { status });
    }
    return NextResponse.json({ installationId: completed.installationId }, { status: 201 });
  }

  if (action === "rotate" || action === "confirm-rotation") {
    const auth = request.headers.get("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    const identity = bearer ? await verifySupportDeviceCredential(bearer) : null;
    if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (action === "rotate") {
      const rotated = await rotateSupportDeviceCredential({
        businessId: identity.businessId,
        installationId: identity.installationId,
        currentBearer: bearer,
        newCredential: typeof body.credential === "string" ? body.credential : "",
      });
      if (!rotated.ok) {
        const status = rotated.error === "credential_rejected" ? 400 : 401;
        return NextResponse.json({ error: rotated.error }, { status });
      }
      await withTenant(identity.businessId, () =>
        recordInstallationContact(identity.businessId, identity.installationId, {}),
      ).catch(() => {});
      return NextResponse.json({ staged: true });
    }
    const confirmed = await confirmSupportDeviceRotation({
      businessId: identity.businessId,
      installationId: identity.installationId,
      newBearer: bearer,
    });
    if (!confirmed.ok) return NextResponse.json({ error: confirmed.error }, { status: 401 });
    return NextResponse.json({ rotated: true });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
