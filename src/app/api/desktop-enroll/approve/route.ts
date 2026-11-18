import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { deploymentRole } from "@/lib/deployment-role";
import { isEnrollmentRequestId } from "@/lib/desktop-enroll";
import {
  approveEnrollmentRequest,
  denyEnrollmentRequest,
} from "@/lib/desktop-enroll-service";
import { isUuid } from "@/lib/uuid";

/**
 * Issue #1115 §A.3 — the signed-in owner confirms (or refuses) a Windows
 * device that asked to enroll, on `/desktop-enroll/<id>`.
 *
 * Owner-only and Cloud-only, like the sibling pairing routes. Approval is
 * gated on real persisted setup readiness for the chosen branch, so a device
 * cannot be enrolled into a half-configured business; when it is not ready the
 * answer carries the blockers and their actions, and the owner resumes later
 * by pressing the same button.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;
  if (deploymentRole() !== "central") {
    return NextResponse.json({ error: "not_central_server" }, { status: 409 });
  }
  // A platform operator's support session acts *in* the business; it may not
  // bind a till to it.
  if (session.imp) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as {
    requestId?: unknown;
    action?: unknown;
    locationId?: unknown;
  } | null;
  if (!isEnrollmentRequestId(body?.requestId)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const requestId = body.requestId;

  if (body?.action === "deny") {
    const denied = await denyEnrollmentRequest({
      businessId: session.businessId,
      requestId,
      deniedBy: session.sub,
    });
    if (!denied) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, state: "denied" });
  }

  if (typeof body?.locationId !== "string" || !isUuid(body.locationId)) {
    return NextResponse.json({ error: "invalid_location" }, { status: 400 });
  }

  const result = await approveEnrollmentRequest({
    businessId: session.businessId,
    requestId,
    locationId: body.locationId,
    approvedBy: session.sub,
    issuedByPlatformUserId: session.platformUserId ?? null,
  });
  if (!result.ok) {
    if (result.error === "not_ready") {
      return NextResponse.json(
        { error: "not_ready", readiness: result.readiness },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, state: "approved" });
});
