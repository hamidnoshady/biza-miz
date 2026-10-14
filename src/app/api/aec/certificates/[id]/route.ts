import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  certificateProjectId,
  deleteCertificate,
  loadCertificate,
  updateCertificate,
} from "@/lib/aec-commercial-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One payment certificate (issue #799 §16): its period, its measured lines, the
 * deductions, the certified figure, its attachments and its §33 trail.
 *
 * The project is resolved from the certificate *before* the authorization
 * check, so a manager of another project in the same business is refused here
 * exactly as they are on the project's own routes.
 *
 * PATCH re-measures a draft. Once a claim has been sent the figures are frozen —
 * in the service and again by migration 0200's trigger — because a claim is a
 * number somebody has already looked at; the way to correct it is `reopen`.
 * DELETE is a draft-only escape hatch.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await certificateProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "view");
      return NextResponse.json({ certificate: await loadCertificate(owner.businessId, id) });
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
      const projectId = await certificateProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const certificate = await updateCertificate(owner, id, await readBody(request));
      return NextResponse.json({ certificate });
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
      const projectId = await certificateProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      await deleteCertificate(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
