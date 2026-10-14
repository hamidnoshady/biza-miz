import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createEstimateVersion, estimateProjectId } from "@/lib/aec-boq-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A new revision of an estimate (issue #799 §7's "versioning").
 *
 * POST — always a draft. With `cloneFromVersionId` it copies that revision's
 *        chapters and lines, which is how a real revision works: you change
 *        four rates, not the whole BOQ. Copying an approved revision is
 *        explicitly allowed and is the normal case — that revision is frozen,
 *        and its successor is a draft that happens to start from its numbers.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await estimateProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const version = await createEstimateVersion(owner, id, await readBody(request));
      return NextResponse.json({ version }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
