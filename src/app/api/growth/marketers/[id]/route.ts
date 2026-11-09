import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { actionableLocationIds } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { parseRosterChange } from "@/lib/marketing-roster";
import { changeMarketer } from "@/lib/marketing-roster-service";
import { isUuid } from "@/lib/uuid";

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketersManage);
  if (error) return error;
  const { id } = await context.params;
  const change = parseRosterChange(await request.json().catch(() => null));
  if (!isUuid(id) || !change) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const result = await changeMarketer(session.businessId, session.sub, await actionableLocationIds(membership), id, change);
  if (result === "not_found") return NextResponse.json({ error: result }, { status: 404 });
  if (result !== "updated") return NextResponse.json({ error: result }, { status: 409 });
  return NextResponse.json({ ok: true });
});
