import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getTailoringJob, linkTailoringJobOrder, transitionTailoringJob } from "@/lib/tailoring-service";
import { tailoringFailure, tailoringScope, uuidSchema } from "@/lib/tailoring-http";
import { TAILORING_STATUSES } from "@/lib/tailoring-workflow";

type Context = { params: Promise<{ id: string }> };

export const GET = withTenantScope(async (_request: Request, context: Context) => {
  const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringManage));
  if (scope.error) return scope.error;
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    return NextResponse.json(await getTailoringJob(scope.actor, id));
  } catch (error) {
    return tailoringFailure(error);
  }
});

const command = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("transition"),
    to: z.enum(TAILORING_STATUSES),
    expectedVersion: z.number().int().positive(),
    estimateRial: z.string().regex(/^\d{1,18}$/).nullable().optional(),
    customerApproved: z.boolean().optional(),
    qcPassed: z.boolean().optional(),
    note: z.string().max(500).nullable().optional(),
  }).strict(),
  z.object({ action: z.literal("link_order"), orderId: uuidSchema }).strict(),
]);

export const POST = withTenantScope(async (request: Request, context: Context) => {
  const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringManage));
  if (scope.error) return scope.error;
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = command.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    if (body.data.action === "link_order") {
      return NextResponse.json({ job: await linkTailoringJobOrder(scope.actor, id, body.data.orderId) });
    }
    const { estimateRial, ...rest } = body.data;
    return NextResponse.json({ job: await transitionTailoringJob(scope.actor, id, {
      ...rest, estimateRial: estimateRial === undefined || estimateRial === null ? estimateRial : BigInt(estimateRial),
    }) });
  } catch (error) {
    return tailoringFailure(error);
  }
});
