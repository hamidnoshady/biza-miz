import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getProfile, listItems, listProfileChanges, saveProfile } from "@/lib/payroll-engine-setup";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

interface Ctx {
  params: Promise<{ userId: string }>;
}

/** One member's payroll profile, recurring items and profile audit history. `payroll.view`. */
export const GET = withTenantScope(async (_request: Request, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;
  const { userId } = await ctx.params;
  const profile = await getProfile(session.businessId, userId);
  if (!profile) return NextResponse.json({ error: "staff_not_found" }, { status: 404 });
  const [items, changes] = await Promise.all([listItems(session.businessId, userId), listProfileChanges(session.businessId, userId)]);
  return NextResponse.json({ profile, items, changes });
});

/** Creates or updates the profile. Audited. `payroll.manage`. */
export const PUT = withTenantScope(async (request: Request, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return badRequest();
  const { userId } = await ctx.params;
  try {
    return NextResponse.json({ profile: await saveProfile({ businessId: session.businessId, actorId: session.sub, userId, body }) });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
