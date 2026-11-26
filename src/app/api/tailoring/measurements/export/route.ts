import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { exportMeasurements } from "@/lib/tailoring-service";
import { tailoringFailure, tailoringScope, uuidSchema } from "@/lib/tailoring-http";

/** GH #1567 6A — data-subject export of every measurement version (logged as `export`). */
export const GET = withTenantScope(async (request: Request) => {
  const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringMeasurements, PERMISSIONS.crmExport));
  if (scope.error) return scope.error;
  const partyId = uuidSchema.safeParse(new URL(request.url).searchParams.get("partyId"));
  if (!partyId.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    const body = await exportMeasurements(scope.actor, partyId.data);
    return new NextResponse(JSON.stringify(body, null, 2), { headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="measurements-${partyId.data}.json"`,
      "Cache-Control": "no-store",
    } });
  } catch (error) {
    return tailoringFailure(error);
  }
});
