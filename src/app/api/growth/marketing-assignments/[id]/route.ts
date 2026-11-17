import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { actionableLocationIds } from "@/lib/authorize";
import { PERMISSIONS } from "@/lib/permissions";
import { parsePriorityChange, parseTransition } from "@/lib/marketing-operations";
import { changeAssignmentPriority, transitionAssignment } from "@/lib/marketing-operations-service";
import { isUuid } from "@/lib/uuid";
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.marketingAssignmentsManage);
  if (error) return error;
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => null);
  const priorityChange = parsePriorityChange(body);
  // The legacy status payload has no action field; an unknown action must not
  // silently fall back to a status transition.
  const hasAction = body !== null && typeof body === "object" && "action" in body;
  const transition = hasAction ? null : parseTransition(body);
  if (!isUuid(id) || (!priorityChange && !transition)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const locations = await actionableLocationIds(membership);
  const result = priorityChange
    ? await changeAssignmentPriority(session.businessId, session.sub, locations, id, priorityChange)
    : await transitionAssignment(session.businessId, session.sub, locations, id, transition!.expected, transition!.next);
  if (result === "invalid") return NextResponse.json({ error: result }, { status: 400 });
  if (result === "not_found") return NextResponse.json({ error: result }, { status: 404 });
  if (result === "conflict") return NextResponse.json({ error: result }, { status: 409 });
  return NextResponse.json({ ok: true });
});
