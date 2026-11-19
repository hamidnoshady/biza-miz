import { NextRequest, NextResponse } from "next/server";
import { normalizeServerAddress } from "@/lib/connection-code";
import {
  hashDeviceSecret,
  isEnrollmentRequestId,
  isUserCodeAlphabet,
  isVerificationUrlFor,
  newDeviceSecret,
  normalizeUserCode,
} from "@/lib/desktop-enroll";
import { localInstallationId } from "@/lib/pairing-apply";
import { PAIRING_SNAPSHOT_VERSION } from "@/lib/pairing-snapshot";
import { hasAnyUser } from "@/lib/setup-state";

/** Long enough for a cold Cloud, short enough that a dead address is obvious. */
const START_TIMEOUT_MS = 20_000;

/**
 * Issue #1115 §A.3 — first-run Hybrid, browser half, on the Windows side.
 *
 * The app has no pairing code to type: it registers itself with the Cloud,
 * mints a secret that never leaves this machine, and hands its window the URL
 * to open in the system browser. Public and session-less for the same reason
 * `/api/setup/pair` is — the database is empty — and it refuses once any user
 * exists, so it can never be used to re-point a working install.
 *
 * The address is accepted in whatever form the owner copied (bare hostname,
 * full dashboard URL, Persian digits) through the same normaliser the typed
 * code path uses, so both Hybrid paths agree on what a Cloud address is.
 */
export async function POST(request: NextRequest) {
  if (await hasAnyUser()) {
    return NextResponse.json({ error: "already_initialized" }, { status: 409 });
  }

  const body = (await request.json().catch(() => null)) as { remoteUrl?: unknown } | null;
  const address = normalizeServerAddress(typeof body?.remoteUrl === "string" ? body.remoteUrl : "");
  if (!address.ok) {
    return NextResponse.json(
      { error: address.error === "missing_address" ? "missing_fields" : "invalid_url" },
      { status: 400 },
    );
  }

  const deviceSecret = newDeviceSecret();
  let response: Response;
  try {
    response = await fetch(`${address.url}/api/desktop-enroll/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        installationId: localInstallationId(),
        deviceName: process.env.DESKTOP_DEVICE_NAME || "Windows Bizamiz",
        deviceSecretHash: hashDeviceSecret(deviceSecret),
        maxSnapshotVersion: PAIRING_SNAPSHOT_VERSION,
      }),
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json({ error: "remote_unreachable" }, { status: 502 });
  }

  const payload = (await response.json().catch(() => null)) as {
    requestId?: unknown;
    userCode?: unknown;
    verificationUrl?: unknown;
    expiresAt?: unknown;
    error?: string;
  } | null;

  if (!response.ok) {
    const known = new Set(["unknown_business", "not_central_server", "insecure_origin"]);
    return NextResponse.json(
      { error: payload?.error && known.has(payload.error) ? payload.error : "remote_unreachable" },
      { status: response.status === 404 ? 404 : 502 },
    );
  }

  // The browser URL is verified before the window ever opens it: same origin
  // the owner typed, exactly this request's path, HTTPS. A Cloud that answers
  // anything else is refused rather than trusted with a click.
  if (
    !isEnrollmentRequestId(payload?.requestId) ||
    typeof payload?.userCode !== "string" ||
    !isUserCodeAlphabet(normalizeUserCode(payload.userCode)) ||
    !isVerificationUrlFor(payload?.verificationUrl, address.url, payload.requestId)
  ) {
    return NextResponse.json({ error: "enrollment_invalid" }, { status: 502 });
  }

  return NextResponse.json(
    {
      requestId: payload.requestId,
      userCode: payload.userCode,
      verificationUrl: payload.verificationUrl,
      expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : null,
      remoteUrl: address.url,
      deviceSecret,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
