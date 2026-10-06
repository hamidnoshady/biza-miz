import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import {
  getProject,
  getProjectCostSummary,
  listProjectAssignableOwners,
  updateProject,
  archiveProject,
  unarchiveProject,
} from "@/lib/ai-projects";

/**
 * GET    — one project
 * PATCH  — update name/instructions
 * DELETE — archive (soft delete)
 */

export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;

    const owner = { businessId: session.businessId, actorUserId: session.sub, projectId: id };
    const [project, cost, owners] = await Promise.all([
      getProject(owner), getProjectCostSummary(owner), listProjectAssignableOwners(owner),
    ]);
    if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
    // Issue #812 §4 — no `agents` list any more. A tenant has no agent builder,
    // so there is nothing to pin: a system agent reaches this project through a
    // Superadmin assignment, never through a project setting.
    return NextResponse.json({ project, cost, owners });
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;

    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

    try {
      const project = await updateProject(
        { businessId: session.businessId, actorUserId: session.sub, projectId: id },
        {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
          ...(body.status === "active" || body.status === "paused" || body.status === "completed" ? { status: body.status } : {}),
          ...(typeof body.ownerUserId === "string" || body.ownerUserId === null ? { ownerUserId: body.ownerUserId } : {}),
          ...(typeof body.budgetRial === "number" || body.budgetRial === null ? { budgetRial: body.budgetRial } : {}),
        },
      );
      if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ project });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal_error";
      if (message.includes("character limit") || message.includes("name is required") || ["invalid_project_status", "invalid_project_budget", "project_owner_not_found"].includes(message)) {
        return NextResponse.json({ error: message }, { status: 400 });
      }
      throw err;
    }
  },
);

export const DELETE = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;

    const url = new URL(request.url);
    const unarchive = url.searchParams.get("unarchive") === "true";

    const ok = unarchive
      ? await unarchiveProject({ businessId: session.businessId, actorUserId: session.sub, projectId: id })
      : await archiveProject({ businessId: session.businessId, actorUserId: session.sub, projectId: id });
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
