import { NextRequest, NextResponse } from "next/server";
import { deploymentRole } from "@/lib/deployment-role";
import { resolveLoginBusinessId } from "@/lib/employee-service";
import { enrollmentVerificationUrl, isInstallationId } from "@/lib/desktop-enroll";
import { startEnrollmentRequest } from "@/lib/desktop-enroll-service";
import { requestHost } from "@/lib/host";

/**
 * Issue #1115 §A.3 — the unpaired Windows app asks the Cloud to hold a
 * reservation so its owner can approve it in the browser.
 *
 * Cloud-only, and public for the same reason `/api/pairing/redeem` is: the
 * caller has no identity yet. The credential that makes the reservation
 * usable is the device secret, whose hash the app registers here and whose
 * plaintext never leaves the machine. The business comes from the origin the
 * app called — never from the body — so a request cannot ask to enroll into
 * somebody else's business.
 */
export async function POST(request: NextRequest) {
  if (deploymentRole() !== "central") {
    return NextResponse.json({ error: "not_central_server" }, { status: 409 });
  }

  const body = (await request.json().catch(() => null)) as {
    installationId?: unknown;
    deviceName?: unknown;
    deviceSecretHash?: unknown;
  } | null;

  if (!isInstallationId(body?.installationId) || !isDeviceSecretProof(body?.deviceSecretHash)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const deviceName =
    typeof body?.deviceName === "string" && body.deviceName.trim()
      ? body.deviceName.trim().slice(0, 120)
      : "Windows Bizamiz";

  const host = requestHost(request.headers);
  const resolved = await resolveLoginBusinessId({ host });
  if (!resolved.businessId) {
    return NextResponse.json({ error: "unknown_business" }, { status: 404 });
  }

  const started = await startEnrollmentRequest({
    businessId: resolved.businessId,
    installationId: body.installationId,
    deviceName,
    deviceSecretHash: body.deviceSecretHash,
  });

  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const verificationUrl = enrollmentVerificationUrl(`${proto}://${host}`, started.requestId);
  if (!verificationUrl) {
    return NextResponse.json({ error: "insecure_origin" }, { status: 409 });
  }

  return NextResponse.json(
    { ...started, verificationUrl },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** The hash the app registers: a SHA-256 hex digest, never the secret itself. */
function isDeviceSecretProof(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
