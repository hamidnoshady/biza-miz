import { NextRequest, NextResponse } from "next/server";
import { normalizeServerAddress } from "@/lib/connection-code";
import { isDeviceSecret, isEnrollmentRequestId } from "@/lib/desktop-enroll";
import { hasAnyUser } from "@/lib/setup-state";

const POLL_TIMEOUT_MS = 10_000;

/**
 * Issue #1115 §A.3 — the Windows window asks its own local server whether the
 * Cloud has approved this device yet.
 *
 * The browser page is on the Cloud origin and the app is on the local origin,
 * so the app cannot poll across origins; this route forwards the poll
 * server-to-server, keeping the device secret out of any browser request. It
 * only ever reaches the fixed `/api/desktop-enroll/poll` path on the address
 * the owner typed, and — like the sibling setup routes — refuses once the
 * install has users, so it cannot become a general outbound proxy.
 */
export async function POST(request: NextRequest) {
  if (await hasAnyUser()) {
    return NextResponse.json({ error: "already_initialized" }, { status: 409 });
  }

  const body = (await request.json().catch(() => null)) as {
    remoteUrl?: unknown;
    requestId?: unknown;
    deviceSecret?: unknown;
  } | null;
  const address = normalizeServerAddress(typeof body?.remoteUrl === "string" ? body.remoteUrl : "");
  if (!address.ok || !isEnrollmentRequestId(body?.requestId) || !isDeviceSecret(body?.deviceSecret)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let response: Response;
  try {
    response = await fetch(`${address.url}/api/desktop-enroll/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ requestId: body.requestId, deviceSecret: body.deviceSecret }),
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ status: "unreachable" }, { status: 502 });
  }

  const payload = (await response.json().catch(() => null)) as { status?: unknown } | null;
  if (!response.ok || typeof payload?.status !== "string") {
    return NextResponse.json({ status: "unreachable" }, { status: 502 });
  }
  return NextResponse.json(
    { ...payload, remoteUrl: address.url },
    { headers: { "Cache-Control": "no-store" } },
  );
}
