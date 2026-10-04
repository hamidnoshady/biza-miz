import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteSiteIssue,
  loadSiteIssue,
  siteIssueProjectId,
  updateSiteIssue,
} from "@/lib/aec-site-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../guard";

/**
 * One issue (issue #799 §14): the finding, its severity, who owes the fix, its
 * due date, its checklist, its evidence and its closeout.
 *
 * PATCH edits what is still editable — a closed or cancelled issue is history
 * (§33) and refuses every change, and a completed closeout cannot be rewritten.
 * It deliberately does *not* move the status: the four acts of §14's register
 * live on `…/status`, because each has consequences (who resolved it, who
 * verified it) that a quiet field write would skip.
 * DELETE is the escape hatch for an issue raised by mistake and not yet started.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await siteIssueProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "view", true);
      return NextResponse.json({ issue: await loadSiteIssue(owner.businessId, id) });
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
      const projectId = await siteIssueProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage", true);
      return NextResponse.json({ issue: await updateSiteIssue(owner, id, await readBody(request)) });
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
      const projectId = await siteIssueProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage", true);
      await deleteSiteIssue(owner, id);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
