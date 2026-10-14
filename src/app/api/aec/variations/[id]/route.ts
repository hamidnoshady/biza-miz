import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteVariation,
  loadVariation,
  updateVariation,
  variationProjectId,
} from "@/lib/aec-commercial-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One change order (issue #799 §15): its description, where it came from, the
 * contract and RFI it points at, its estimate, cost impact, schedule impact, the
 * amount claimed and the amount agreed, its attachments, its §33 trail and the
 * approval it filed.
 *
 * The project is resolved from the variation *before* the authorization check,
 * so a manager of another project in the same business is refused here exactly
 * as they are on the project's own routes.
 *
 * PATCH edits what is still editable — Draft and Priced. From `submitted` on,
 * what the client received is frozen in the service and again by migration
 * 0200's trigger; the way forward is `…/status`'s `reopen`, which is a
 * deliberate act with its own event. DELETE is a draft-only escape hatch for a
 * change raised by mistake.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await variationProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "view");
      return NextResponse.json({ variation: await loadVariation(owner.businessId, id) });
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
      const projectId = await variationProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const variation = await updateVariation(owner, id, await readBody(request));
      return NextResponse.json({ variation });
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
      const projectId = await variationProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      await deleteVariation(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
