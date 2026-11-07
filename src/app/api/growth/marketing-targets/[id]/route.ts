import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { actionableLocationIds } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { parseTargetChange } from "@/lib/marketing-operations";
import { changeTarget } from "@/lib/marketing-operations-service";
import { isUuid } from "@/lib/uuid";

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketingTargetsManage);
  if (error) return error;
  const { id } = await context.params;
  const input = parseTargetChange(await request.json().catch(() => null));
  if (!isUuid(id) || !input) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const result = await changeTarget(session.businessId, session.sub, await actionableLocationIds(membership), id, input);
  if (result === "not_found") return NextResponse.json({ error: result }, { status: 404 });
  if (result !== "updated") return NextResponse.json({ error: result }, { status: 409 });
  return NextResponse.json({ ok: true });
});
