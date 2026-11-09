import { NextRequest, NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { actionableLocationIds } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { parseTouchInput } from "@/lib/marketing-touchpoints";
import { listOwnMarketingTouches, recordOwnMarketingTouch } from "@/lib/marketing-touchpoints-service";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermissions(PERMISSIONS.marketingAssignmentsSelf, PERMISSIONS.crmView, PERMISSIONS.crmManage);
  if (error) return error;
  const page = Number(request.nextUrl.searchParams.get("page") ?? 1);
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || q.length > 150) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json(await listOwnMarketingTouches(session.businessId, session.sub, await actionableLocationIds(membership), q, page));
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermissions(PERMISSIONS.marketingAssignmentsSelf, PERMISSIONS.crmView, PERMISSIONS.crmManage);
  if (error) return error;
  const input = parseTouchInput(await request.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const result = await recordOwnMarketingTouch(session.businessId, session.sub, await actionableLocationIds(membership), input);
  if (result.kind === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (result.kind === "conflict" || result.kind === "party_mismatch") return NextResponse.json({ error: result.kind }, { status: 409 });
  return NextResponse.json({ id: result.id, replayed: result.kind === "replayed" }, { status: result.kind === "created" ? 201 : 200 });
});
