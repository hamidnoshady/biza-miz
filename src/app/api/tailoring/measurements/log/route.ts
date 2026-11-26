import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { measurementAccessLog } from "@/lib/tailoring-service";
import { tailoringFailure, tailoringScope, uuidSchema } from "@/lib/tailoring-http";

/** GH #1567 6A — who opened a customer's measurements, when and why (no values). */
export const GET = withTenantScope(async (request: Request) => {
  const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringMeasurements));
  if (scope.error) return scope.error;
  const partyId = uuidSchema.safeParse(new URL(request.url).searchParams.get("partyId"));
  if (!partyId.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ entries: await measurementAccessLog(scope.actor, partyId.data) });
  } catch (error) {
    return tailoringFailure(error);
  }
});
