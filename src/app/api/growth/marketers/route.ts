import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { actionableLocationIds } from "@/lib/authorize";
import { parseRosterInput } from "@/lib/marketing-roster";
import { createMarketer, listMarketers } from "@/lib/marketing-roster-service";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketersView);
  if (error) return error;
  const params = request.nextUrl.searchParams;
  const page = Number(params.get("page") ?? 1);
  const search = (params.get("q") ?? "").trim();
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || search.length > 150) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const locations = await actionableLocationIds(membership);
  return NextResponse.json(await listMarketers(session.businessId, locations, search, page));
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketersManage);
  if (error) return error;
  const input = parseRosterInput(await request.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const locations = await actionableLocationIds(membership);
  try {
    const marketer = await createMarketer(session.businessId, session.sub, locations, input);
    if (!marketer) return NextResponse.json({ error: "invalid_location_or_user" }, { status: 400 });
    return NextResponse.json({ marketer }, { status: 201 });
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "23505" && "constraint" in e && e.constraint === "marketing_agents_one_employee") return NextResponse.json({ error: "marketer_already_exists" }, { status: 409 });
    throw e;
  }
});
