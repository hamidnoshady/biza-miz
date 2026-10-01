import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createEvent, deleteEvent, listCalendar } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../guard";

/**
 * The unified calendar: stored events unioned with four derived date sources
 * (project deadlines, task due dates, contract expiries, approval deadlines).
 * The derived four are read from the rows that own them, so a rescheduled task
 * moves on the calendar because it is the same fact, not a copy of it.
 *
 * Dates cross this boundary as ISO/Gregorian; the Shamsi rendering happens in
 * the client, which is the repo's standing rule.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  const params = new URL(request.url).searchParams;
  const from = params.get("from");
  const to = params.get("to");
  if (!from || !to) return NextResponse.json({ error: "range_required" }, { status: 400 });
  try {
    const entries = await listCalendar(owner, {
      from, to, projectId: params.get("projectId") ?? undefined,
    });
    return NextResponse.json({ entries });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
  if (error) return error;
  const body = await readBody(request);
  try {
    return NextResponse.json({ entries: await createEvent(owner, body) }, { status: 201 });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
  if (error) return error;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  try {
    return NextResponse.json({ deleted: await deleteEvent(owner, id) });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
