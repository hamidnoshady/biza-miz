import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { deleteRfq, loadRfq, rfqProjectId, updateRfq } from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One RFQ (issue #799 §18): its scope, the dates it is due, who was invited and
 * whether they answered, and — the part that makes this a *comparison* rather
 * than a list — every quotation received, ordered by amount.
 *
 * Suppliers are `parties` and stay that way (§18): a business's supplier is the
 * same record its contracts name, and an external party gets no business-wide
 * access.
 *
 * PATCH edits a draft only; once issued, what the suppliers received is frozen
 * in the service and again by migration 0201's trigger. DELETE is draft-only.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await rfqProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "view");
      return NextResponse.json({ rfq: await loadRfq(owner.businessId, id) });
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
      const projectId = await rfqProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const rfq = await updateRfq(owner, id, await readBody(request));
      return NextResponse.json({ rfq });
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
      const projectId = await rfqProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      await deleteRfq(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
