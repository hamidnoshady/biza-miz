import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createTailoringJob, listTailoringJobs } from "@/lib/tailoring-service";
import { tailoringFailure, tailoringScope, uuidSchema } from "@/lib/tailoring-http";
import { TAILORING_STATUSES } from "@/lib/tailoring-workflow";

/** GH #1567 6A — the alteration desk: list and open jobs (no measurement values ever). */
export const GET = withTenantScope(async (request: Request) => {
  const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringManage));
  if (scope.error) return scope.error;
  const location = await resolveActiveLocation(scope.session);
  if (!location) return NextResponse.json({ error: "location_required" }, { status: 409 });
  const status = z.enum(TAILORING_STATUSES).optional().safeParse(new URL(request.url).searchParams.get("status") ?? undefined);
  if (!status.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ jobs: await listTailoringJobs(scope.actor, location.id, status.data) });
  } catch (error) {
    return tailoringFailure(error);
  }
});

const createBody = z.object({
  partyId: uuidSchema,
  kind: z.enum(["alteration", "made_to_measure"]),
  description: z.string().trim().min(1).max(1000),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  measurementProfileId: uuidSchema.nullable().optional(),
}).strict();

export const POST = withTenantScope(async (request: Request) => {
  const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringManage));
  if (scope.error) return scope.error;
  const location = await resolveActiveLocation(scope.session);
  if (!location) return NextResponse.json({ error: "location_required" }, { status: 409 });
  const body = createBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ job: await createTailoringJob(scope.actor, { ...body.data, locationId: location.id }) }, { status: 201 });
  } catch (error) {
    return tailoringFailure(error);
  }
});
