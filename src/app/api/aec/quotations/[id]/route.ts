import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteQuotation,
  quotationProjectId,
  updateQuotation,
} from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One supplier quotation (§18): the amount, the lead time, how long the offer
 * stands, and the note the buyer wrote next to it.
 *
 * Correcting a figure a supplier read out over the phone is ordinary register
 * work on `workspace.manage` — but only while the offer has not been acted on.
 * Once it has been shortlisted, selected or declined, the comparison sheet is a
 * record of what was decided, and the service freezes it.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await quotationProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const quotation = await updateQuotation(owner, id, await readBody(request));
      return NextResponse.json({ quotation });
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
      const projectId = await quotationProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      await deleteQuotation(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
