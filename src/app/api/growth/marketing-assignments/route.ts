import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { actionableLocationIds } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { parseAssignmentInput } from "@/lib/marketing-operations";
import { createAssignment, listAssignments } from "@/lib/marketing-operations-service";
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketingAssignmentsView);
  if (error) return error;
  const page = Number(request.nextUrl.searchParams.get("page") ?? 1);
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || q.length > 150) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json(await listAssignments(session.businessId, await actionableLocationIds(membership), q, page));
});
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketingAssignmentsManage);
  if (error) return error;
  const input = parseAssignmentInput(await request.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    const assignment = await createAssignment(session.businessId, session.sub, await actionableLocationIds(membership), input);
    return assignment ? NextResponse.json({ assignment }, { status: 201 }) : NextResponse.json({ error: "invalid_assignment" }, { status: 400 });
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "23505" && "constraint" in e && e.constraint === "marketing_assignments_one_open") return NextResponse.json({ error: "assignment_already_open" }, { status: 409 });
    throw e;
  }
});
