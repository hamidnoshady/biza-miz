import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createTransmittal, listProjectTransmittals } from "@/lib/aec-doc-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A project's transmittals (issue #799 §12).
 *
 * GET  — the register of what was sent, newest first.
 * POST — a *draft*: number, subject, sender, issue date, purpose, comments, and
 *        the lines and recipients it will carry. A draft is fully editable;
 *        issuing it is `/api/aec/transmittals/[id]/status`, which is gated on
 *        `workspace.documents_issue` because that is the act that cannot be
 *        taken back.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      return NextResponse.json({ transmittals: await listProjectTransmittals(owner.businessId, id) });
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
      const transmittal = await createTransmittal(owner, id, await readBody(request));
      return NextResponse.json({ transmittal }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
