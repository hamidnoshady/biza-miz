import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteSubmittalRevision,
  submittalRevisionProjectId,
  updateSubmittalRevision,
} from "@/lib/aec-rfi-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One draft revision of a submittal (issue #799 §11): its file, its due date and
 * its reviewer.
 *
 * Both methods are draft-only. A submitted revision is what a reviewer saw, so
 * the service refuses and migration 0198's trigger refuses again — the way to
 * change a submitted document is the next revision, not an edit of this one. The
 * project is resolved through the revision's parent before the role check.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const { projectId } = await submittalRevisionProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const submittal = await updateSubmittalRevision(owner, id, await readBody(request));
      return NextResponse.json({ submittal });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const { projectId } = await submittalRevisionProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      await deleteSubmittalRevision(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
