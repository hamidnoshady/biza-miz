import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteMaterialRequest,
  loadMaterialRequest,
  requestProjectId,
  updateMaterialRequest,
} from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One material request (issue #799 §18): its title, description, work package,
 * priority, the date it is needed by, its lines (each optionally pointing at the
 * BOQ item it came from), and its §33 trail.
 *
 * The project is resolved from the request *before* the authorization check, so
 * a manager of another project in the same business is refused here exactly as
 * they are on the project's own routes.
 *
 * PATCH edits Draft and Rejected only — a submitted requirement is what the
 * suppliers were asked to price, and migration 0201's trigger freezes those eight
 * fields rather than trusting this function — and DELETE is a draft-only escape
 * hatch for a request raised by mistake.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await requestProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "view");
      return NextResponse.json({ materialRequest: await loadMaterialRequest(owner.businessId, id) });
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
      const projectId = await requestProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const materialRequest = await updateMaterialRequest(owner, id, await readBody(request));
      return NextResponse.json({ materialRequest });
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
      const projectId = await requestProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      await deleteMaterialRequest(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
