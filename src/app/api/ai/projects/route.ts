import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createProject, listProjects } from "@/lib/ai-projects";
import { PERMISSIONS, workspaceOwner } from "@/app/api/workspace/guard";

/**
 * GET  — list the caller's projects (optionally including archived)
 * POST — create a new project
 *
 * Issue #907 F01 — this surface used to stop at `getSession()`: any member of
 * the business could exercise it, and every project-scoped route beneath it
 * inherited that. It now takes the same two gates as the workspace routes it
 * writes into: the platform capability here, and (on the per-project routes)
 * the project role from `workspace_members`.
 */

export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView, request);
  if (error) return error;

  const url = new URL(request.url);
  const includeArchived = url.searchParams.get("archived") === "true";
  const projects = await listProjects(
    { businessId: owner.businessId, actorUserId: owner.actorUserId },
    { includeArchived },
  );
  return NextResponse.json({ projects });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage, request);
  if (error) return error;

  const body = await request.json().catch(() => null);
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  try {
    const project = await createProject(
      { businessId: owner.businessId, actorUserId: owner.actorUserId },
      { name: body.name, instructions: body.instructions },
    );
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal_error";
    if (message.includes("character limit")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    throw err;
  }
});
