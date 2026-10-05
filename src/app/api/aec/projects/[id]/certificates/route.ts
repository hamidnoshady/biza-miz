import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createCertificate, listProjectCertificates } from "@/lib/aec-commercial-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A project's payment certificates (issue #799 §16).
 *
 * GET  — every claim on the project, newest period first, each with its period,
 *        progress, gross, deductions, net, what was certified before it on the
 *        same contract, and what the contract still owes after it.
 * POST — measure one. It starts as a draft and is numbered `PC-001` per project;
 *        the net figure is always computed by the service (and checked by
 *        migration 0200), never stated by the caller, because the form's preview
 *        and the stored row must be one calculation.
 *
 * Reading needs `workspace.view`, writing `workspace.manage`. *Certifying* a
 * claim is not here — that is `…/certificates/[id]/status`, on
 * `workspace.approve` (§24).
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      return NextResponse.json({
        certificates: await listProjectCertificates(owner.businessId, id),
      });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "manage");
      const certificate = await createCertificate(owner, id, await readBody(request));
      return NextResponse.json({ certificate }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
