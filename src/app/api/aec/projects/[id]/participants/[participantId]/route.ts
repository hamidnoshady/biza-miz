import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { removeProjectParticipant, updateProjectParticipant } from "@/lib/aec-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../../guard";

/**
 * One participant on one project.
 *
 * PATCH  — amend the role, the contact person or the engagement window. A role
 *          change is re-checked against the operating profile, so turning the
 *          `subcontractors` capability off cannot be worked around by promoting
 *          an existing row.
 * DELETE — remove the row. The party itself is untouched: this table records a
 *          role on a project, not the counterparty.
 *
 * Same two-layer authorization as the collection route above.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string; participantId: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id, participantId } = await context.params;
    const body = await readBody(request);
    try {
      await requireProjectCapability(owner, id, "manage");
      return NextResponse.json({
        participants: await updateProjectParticipant(owner, id, participantId, body),
      });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string; participantId: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id, participantId } = await context.params;
    try {
      await requireProjectCapability(owner, id, "manage");
      return NextResponse.json({
        participants: await removeProjectParticipant(owner, id, participantId),
      });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
