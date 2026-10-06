import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { deleteDelivery, deliveryProjectId } from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError } from "../../guard";

/**
 * A delivery recorded by mistake (§18). Correcting the receipt is ordinary
 * register work — the fact that a lorry arrived is not a decision — and the
 * removal is written to the award's §33 trail, so the register keeps both the
 * mistaken entry and the correction rather than silently rewriting history.
 */
export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await deliveryProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      await deleteDelivery(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
