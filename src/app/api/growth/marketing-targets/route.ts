import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requirePermissions, withTenantScope } from "@/lib/auth";
import { actionableLocationIds } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { parseTargetInput } from "@/lib/marketing-operations";
import { createTarget, listTargets } from "@/lib/marketing-operations-service";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketingTargetsView);
  if (error) return error;
  const page = Number(request.nextUrl.searchParams.get("page") ?? 1);
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || q.length > 150) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json(await listTargets(session.businessId, await actionableLocationIds(membership), q, page));
});
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermissions(PERMISSIONS.marketingTargetsManage, PERMISSIONS.partiesView);
  if (error) return error;
  const input = parseTargetInput(await request.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const target = await createTarget(session.businessId, session.sub, await actionableLocationIds(membership), input);
  return target ? NextResponse.json({ target }, { status: 201 }) : NextResponse.json({ error: "invalid_location_or_party" }, { status: 400 });
});
