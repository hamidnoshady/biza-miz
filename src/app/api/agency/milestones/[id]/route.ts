import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteAgencyMilestone,
  loadAgencyMilestone,
  updateAgencyMilestone,
} from "@/lib/agency-commercial-service";
import { PERMISSIONS, agencyOwner, handleAgencyError, readBody } from "../../guard";

/**
 * One billing milestone (issue #1128 §D): its kind, its title, the percentage or
 * fixed amount it bills, what that resolves to against the engagement's revised
 * value, the revenue account it will credit, its dates, and the acts it can take
 * from where it is.
 *
 * PATCH edits what is still editable — a draft or a refused milestone. From
 * `submitted` on, what an approver is reading is frozen in the service and again
 * by migration 0260's trigger; the way forward is `…/status`'s `reopen` after a
 * refusal or `withdraw` before anybody decides.
 *
 * DELETE is a draft-only escape hatch for a stage added by mistake. A milestone
 * that has been invoiced is the record of money that exists in the ledger: it is
 * amended or voided in Accounting, and this register reads the outcome rather
 * than duplicating it.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await agencyOwner(PERMISSIONS.workspaceView, _request);
    if (error) return error;
    const { id } = await context.params;
    try {
      return NextResponse.json({ milestone: await loadAgencyMilestone(owner, id) });
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
      const milestone = await updateAgencyMilestone(owner, id, await readBody(request));
      return NextResponse.json({ milestone });
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
      const deleted = await deleteAgencyMilestone(owner, id);
      if (!deleted) {
        return NextResponse.json({ error: "milestone_not_editable" }, { status: 409 });
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAgencyError(err);
    }
  },
);
