import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { recordMeasurements, viewMeasurements } from "@/lib/tailoring-service";
import { tailoringFailure, tailoringScope, uuidSchema } from "@/lib/tailoring-http";
import { parseAccessPurpose } from "@/lib/tailoring-workflow";

/**
 * GH #1567 6A — a customer's body measurements. Opening them requires
 * `tailoring.measurements` and a stated purpose; every access is logged.
 * Not an AI/MCP surface (coverage map: route-only by design).
 */
export const GET = withTenantScope(async (request: Request) => {
  const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringMeasurements));
  if (scope.error) return scope.error;
  const params = new URL(request.url).searchParams;
  const partyId = uuidSchema.safeParse(params.get("partyId"));
  const purpose = parseAccessPurpose(params.get("purpose"));
  if (!partyId.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!purpose) return NextResponse.json({ error: "tailoring_purpose_required" }, { status: 400 });
  try {
    return NextResponse.json(await viewMeasurements(scope.actor, partyId.data, purpose),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return tailoringFailure(error);
  }
});

const recordBody = z.object({ partyId: uuidSchema, measurements: z.unknown() }).strict();

export const POST = withTenantScope(async (request: Request) => {
  const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringMeasurements));
  if (scope.error) return scope.error;
  const body = recordBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ version: await recordMeasurements(scope.actor, body.data.partyId, body.data.measurements) }, { status: 201 });
  } catch (error) {
    return tailoringFailure(error);
  }
});
