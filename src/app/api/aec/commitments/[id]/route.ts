import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  commitmentProjectId,
  deleteCommitment,
  loadCommitment,
  updateCommitment,
} from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One commitment (§18): the award, its supplier, the value, the expected
 * delivery, the deliveries that arrived and who signed for them, its
 * attachments and its §33 trail.
 *
 * PATCH edits a draft only — from `submitted` on, the award is frozen in the
 * service and again by migration 0201's trigger, because it is the number that
 * just went into the project's committed cost. DELETE is a draft-only escape
 * hatch. Deliveries are recorded on `…/deliveries`, which the database refuses
 * against an award that has not been approved.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await commitmentProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "view");
      return NextResponse.json({ commitment: await loadCommitment(owner.businessId, id) });
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
      const projectId = await commitmentProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const commitment = await updateCommitment(owner, id, await readBody(request));
      return NextResponse.json({ commitment });
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
      const projectId = await commitmentProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      await deleteCommitment(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
