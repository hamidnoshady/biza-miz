import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { addProjectParticipant, listProjectParticipants } from "@/lib/aec-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * The external participants on one project — §6's «طرف‌های پروژه».
 *
 * GET  — the participants, grouped for the picker by party name within role
 *        group.
 * POST — record one, by role. The role is checked against the business's
 *        operating profile, not just the catalogue: a role whose capability is
 *        switched off is refused with `role_not_allowed`.
 *
 * Both are reads/writes of records, never grants. Attaching a party here
 * creates no user and no membership (`workspace_members` remains the only
 * source of internal authorization), so an external consultant named on a
 * project still cannot open it without a business-wide permission and a project
 * role.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view", true);
      return NextResponse.json({ participants: await listProjectParticipants(owner.businessId, id) });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      await requireProjectCapability(owner, id, "manage", true);
      return NextResponse.json(
        { participants: await addProjectParticipant(owner, id, body) },
        { status: 201 },
      );
    } catch (err) {
      return handleAecError(err);
    }
  },
);
