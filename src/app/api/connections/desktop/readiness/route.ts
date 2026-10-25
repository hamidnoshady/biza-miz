import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { deploymentRole } from "@/lib/deployment-role";
import { readEnrollmentReadiness } from "@/lib/desktop-enrollment-readiness-service";
import { isUuid } from "@/lib/uuid";

/**
 * Issue #1115 §A.2 — is this business, at this branch, ready for a new Windows
 * Hybrid install to be enrolled? Answered from persisted setup state, never
 * from the request: the query string only names a branch and the client's
 * protocol version, and both are validated before use.
 *
 * Owner-only and Cloud-only, like the sibling pairing routes. Read-only and
 * idempotent, so a desktop that paused on «کسب‌وکار خود را ابتدا در ابر کامل
 * کنید» resumes by asking again; `blockerCodes` is stable and sorted for that.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;
  if (deploymentRole() !== "central") {
    return NextResponse.json({ error: "not_central_server" }, { status: 409 });
  }
  const params = request.nextUrl.searchParams;
  const locationId = params.get("locationId");
  if (locationId !== null && !isUuid(locationId)) {
    return NextResponse.json({ error: "invalid_location" }, { status: 400 });
  }
  const version = params.get("maxSnapshotVersion");
  let clientMaxSnapshotVersion: number | null = null;
  if (version !== null) {
    clientMaxSnapshotVersion = Number(version);
    if (!Number.isSafeInteger(clientMaxSnapshotVersion) || clientMaxSnapshotVersion < 0) {
      return NextResponse.json({ error: "invalid_snapshot_version" }, { status: 400 });
    }
  }
  const readiness = await readEnrollmentReadiness({
    businessId: session.businessId,
    locationId,
    clientMaxSnapshotVersion,
  });
  return NextResponse.json({ readiness });
});
