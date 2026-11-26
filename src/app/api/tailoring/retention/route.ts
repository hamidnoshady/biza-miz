import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getRetentionDays, purgeExpiredMeasurements, setRetentionDays } from "@/lib/tailoring-service";
import { tailoringFailure, tailoringScope } from "@/lib/tailoring-http";

/** GH #1567 6A — measurement retention: read, set, and a dry-run-first purge. */
export const GET = withTenantScope(async () => {
  const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringMeasurements, PERMISSIONS.settingsManage));
  if (scope.error) return scope.error;
  try {
    return NextResponse.json({
      retentionDays: await getRetentionDays(scope.actor.businessId),
      preview: await purgeExpiredMeasurements(scope.actor, { apply: false }),
    });
  } catch (error) {
    return tailoringFailure(error);
  }
});

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), days: z.number().int().min(30).max(3650) }).strict(),
  z.object({ action: z.literal("purge"), confirm: z.literal(true) }).strict(),
]);

export const POST = withTenantScope(async (request: Request) => {
  const scope = await tailoringScope(await requirePermissions(PERMISSIONS.tailoringMeasurements, PERMISSIONS.settingsManage));
  if (scope.error) return scope.error;
  const parsed = command.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    if (parsed.data.action === "set") return NextResponse.json(await setRetentionDays(scope.actor, parsed.data.days));
    return NextResponse.json(await purgeExpiredMeasurements(scope.actor, { apply: true }));
  } catch (error) {
    return tailoringFailure(error);
  }
});
