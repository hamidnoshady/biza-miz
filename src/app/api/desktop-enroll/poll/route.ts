import { NextRequest, NextResponse } from "next/server";
import { deploymentRole } from "@/lib/deployment-role";
import { isDeviceSecret, isEnrollmentRequestId } from "@/lib/desktop-enroll";
import { pollEnrollmentRequest } from "@/lib/desktop-enroll-service";

/**
 * Issue #1115 §A.3 — the unpaired Windows app asks whether its owner has
 * approved the device in the browser yet.
 *
 * The device secret is the credential, and it is the only thing that can turn
 * the sealed pairing code into a response: a caller with the request id and
 * nothing else learns nothing, not even that the id exists. `no-store` on
 * every answer because `approved` carries a one-time credential.
 */
export async function POST(request: NextRequest) {
  if (deploymentRole() !== "central") {
    return NextResponse.json({ error: "not_central_server" }, { status: 409 });
  }
  const body = (await request.json().catch(() => null)) as {
    requestId?: unknown;
    deviceSecret?: unknown;
  } | null;
  if (!isEnrollmentRequestId(body?.requestId) || !isDeviceSecret(body?.deviceSecret)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await pollEnrollmentRequest({
    requestId: body.requestId,
    deviceSecret: body.deviceSecret,
  });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
