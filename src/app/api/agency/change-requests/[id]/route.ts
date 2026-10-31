import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteAgencyChangeRequest,
  loadAgencyChangeRequest,
  updateAgencyChangeRequest,
} from "@/lib/agency-commercial-service";
import { PERMISSIONS, agencyOwner, handleAgencyError, readBody } from "../../guard";

/**
 * One change request (issue #1128 §D): what changes, why, what it costs, what
 * the client agreed to, what it does to the schedule, and whether its figure is
 * one the engagement's value now includes.
 *
 * PATCH edits what is still editable — a draft, a priced request, or one the
 * client refused. From `submitted` on, what the client is reading is frozen in
 * the service and again by migration 0260's trigger; the way forward is
 * `…/status`'s `reprice` after a refusal or `withdraw` before anybody decides.
 *
 * Re-pricing a refused request drops the figure the client rejected, so the next
 * approval cannot inherit an amount nobody agreed to.
 *
 * DELETE is a draft-only escape hatch. A request the client has seen is
 * withdrawn, not deleted: the refusal or the withdrawal is the record of a
 * conversation that happened.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await agencyOwner(PERMISSIONS.workspaceView, _request);
    if (error) return error;
    const { id } = await context.params;
    try {
      return NextResponse.json({
        changeRequest: await loadAgencyChangeRequest(owner, id),
      });
    } catch (err) {
      return handleAgencyError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await agencyOwner(PERMISSIONS.workspaceManage, request);
    if (error) return error;
    const { id } = await context.params;
    try {
      const changeRequest = await updateAgencyChangeRequest(owner, id, await readBody(request));
      return NextResponse.json({ changeRequest });
    } catch (err) {
      return handleAgencyError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await agencyOwner(PERMISSIONS.workspaceManage, _request);
    if (error) return error;
    const { id } = await context.params;
    try {
      const deleted = await deleteAgencyChangeRequest(owner, id);
      if (!deleted) {
        return NextResponse.json({ error: "change_request_not_editable" }, { status: 409 });
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAgencyError(err);
    }
  },
);
