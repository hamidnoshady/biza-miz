import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteSubmittal,
  loadSubmittal,
  submittalProjectId,
  updateSubmittal,
} from "@/lib/aec-rfi-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One submittal (issue #799 §11): its identity, its attachments and its whole
 * revision history with each revision's determination.
 *
 * The project is resolved from the submittal *before* the authorization check,
 * so a manager of another project is refused here as everywhere else.
 *
 * PATCH edits the register entry. Once a revision is out with a reviewer the
 * number, the type and the specification section are frozen (the service refuses
 * and migration 0198's `aec_submittal_guard()` refuses again): changing what a
 * submission answers after it was reviewed would rewrite what was approved.
 * DELETE is refused while any revision has been submitted — the log keeps what
 * was sent, and the escape hatch is only for a register entry created by mistake.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await submittalProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "view");
      return NextResponse.json({ submittal: await loadSubmittal(owner.businessId, id) });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await submittalProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const submittal = await updateSubmittal(owner, id, await readBody(request));
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
      const projectId = await submittalProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      await deleteSubmittal(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
