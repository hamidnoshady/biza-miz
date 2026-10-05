import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { commitmentProjectId, recordDelivery } from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * §18's delivery tracking: what arrived, when, and who signed for it.
 *
 * A delivery is a *fact*, not a decision — nobody approves a lorry — so it rides
 * `workspace.manage`. What keeps it honest is the database: migration 0201's
 * guard refuses a delivery against a commitment that is not `approved` (or
 * already `delivered`), so "delivered" can never be a status somebody types
 * before the award exists.
 *
 * The receipt names a real member of the business (`receivedById`, defaulting to
 * the caller) and the service refuses a user from another tenant.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await commitmentProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const commitment = await recordDelivery(owner, id, await readBody(request));
      return NextResponse.json({ commitment }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
