import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteTransmittal,
  loadTransmittal,
  transmittalProjectId,
  updateTransmittal,
} from "@/lib/aec-doc-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One transmittal (issue #799 §12), with its lines and recipients.
 *
 * PATCH and DELETE are refused once it has been issued — `transmittal_not_editable`
 * (409) from here, and the same refusal from migration 0197's trigger. §12 asks
 * for an auditable answer to "what exactly was issued, in which revision, to
 * whom, and when"; a record that can be edited afterwards does not give one.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await transmittalProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "view", true);
      return NextResponse.json({ transmittal: await loadTransmittal(owner.businessId, id) });
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
      const projectId = await transmittalProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage", true);
      const transmittal = await updateTransmittal(owner, id, await readBody(request));
      return NextResponse.json({ transmittal });
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
      const projectId = await transmittalProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage", true);
      await deleteTransmittal(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
