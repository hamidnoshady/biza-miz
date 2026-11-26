import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { eraseMeasurements } from "@/lib/tailoring-service";
import { tailoringFailure, tailoringScope, uuidSchema } from "@/lib/tailoring-http";

const body = z.object({ partyId: uuidSchema, reason: z.string().trim().min(3).max(500), confirm: z.literal(true) }).strict();

/** GH #1567 6A — erase all of a customer's measurement values (rows and access log remain). */
export const POST = withTenantScope(async (request: Request) => {
  const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringMeasurements, PERMISSIONS.crmDelete));
  if (scope.error) return scope.error;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json(await eraseMeasurements(scope.actor, parsed.data.partyId, parsed.data.reason));
  } catch (error) {
    return tailoringFailure(error);
  }
});
