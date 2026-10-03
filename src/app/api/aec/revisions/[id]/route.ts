import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { deleteRevision, revisionProjectId, updateRevision } from "@/lib/aec-doc-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One revision of a drawing (issue #799 §9).
 *
 * PATCH and DELETE are both refused for a revision that is no longer a draft —
 * here with `revision_not_editable` (409) and again by migration 0197's trigger,
 * with the same message for a hand-run SQL statement. That is §9's "approved and
 * issued revisions must be immutable" enforced at the layer that cannot be
 * bypassed, and it is why there is no "un-issue" endpoint to go looking for.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await revisionProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage", true);
      const revision = await updateRevision(owner, id, await readBody(request));
      return NextResponse.json({ revision });
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
      const projectId = await revisionProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage", true);
      await deleteRevision(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
