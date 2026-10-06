import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  contractProjectId,
  loadContractCommercial,
  saveContractCommercial,
} from "@/lib/aec-commercial-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * §17's AEC block on an execution contract: the contract number, the scope, the
 * advance and retention terms, the payment terms, the defects-liability period,
 * the guarantee and insurance references and their expiry dates, and the
 * responsible manager.
 *
 * The block extends the contract row rather than replacing it — the original
 * value, the counterparty and the dates stay on `workspace_contracts` (0167) —
 * and `revised_value_rial` is computed by migration 0200's trigger from the
 * original plus the approved variations, so it is neither readable nor writable
 * from a request body. That is §15's rule ("must not rewrite the original
 * contract amount") enforced rather than promised.
 *
 * A contract without a project is business-level, so the project capability
 * check is skipped for it — the same shape the workspace's own contract routes
 * use, since `resolveWorkspaceSubject` refuses a subject whose project the actor
 * cannot reach.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await contractProjectId(owner.businessId, id);
      if (projectId) await requireProjectCapability(owner, projectId, "view");
      return NextResponse.json({ commercial: await loadContractCommercial(owner.businessId, id) });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const PUT = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await contractProjectId(owner.businessId, id);
      if (projectId) await requireProjectCapability(owner, projectId, "manage");
      const commercial = await saveContractCommercial(owner, id, await readBody(request));
      return NextResponse.json({ commercial });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
