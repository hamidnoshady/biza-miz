import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  addPhase,
  applyTemplate,
  deletePhase,
  getWorkspaceProject,
  listPhases,
  listTemplates,
  requireProjectCapability,
  updatePhase,
} from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../../guard";

/**
 * GET    — the project's phases, each with its task roll-up.
 * POST   — add one phase, or apply a whole template (`{ templateKey }`).
 * PATCH  — rename / restage / re-order / re-date one phase.
 * DELETE — remove a phase; its tasks keep existing with a null phase rather
 *          than being deleted along with it (the FK is ON DELETE SET NULL).
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      return NextResponse.json({ phases: await listPhases(id) });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      await requireProjectCapability(owner, id, "manage");
      if (typeof body.templateKey === "string" && body.templateKey) {
        const templates = await listTemplates(owner.businessId);
        const template = templates.find((t) => t.key === body.templateKey);
        if (!template) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
        const project = await getWorkspaceProject(owner.businessId, id);
        // A merge: phases and starter tasks the project already has are
        // skipped, so re-applying a template never duplicates anything.
        const added = await applyTemplate(owner, id, template, project?.startDate ?? null);
        return NextResponse.json({ phases: await listPhases(id), added }, { status: 201 });
      }
      const phases = await addPhase(owner, id, {
        name: String(body.name ?? ""),
        startDate: body.startDate,
        endDate: body.endDate,
      });
      return NextResponse.json({ phases }, { status: 201 });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      await requireProjectCapability(owner, id, "manage");
      const phases = await updatePhase(owner, id, String(body.phaseId ?? ""), {
        name: body.name as string | undefined,
        status: body.status as string | undefined,
        displayOrder: body.displayOrder as number | undefined,
        startDate: body.startDate,
        endDate: body.endDate,
      });
      return NextResponse.json({ phases });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const phaseId = new URL(request.url).searchParams.get("phaseId") ?? "";
    try {
      await requireProjectCapability(owner, id, "manage");
      return NextResponse.json({ phases: await deletePhase(id, phaseId) });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
