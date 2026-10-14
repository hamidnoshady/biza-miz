import { NextRequest, NextResponse } from "next/server";
import { getSession, requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  MAX_MEMORY_CHARS,
  createMemoryEntry,
  deleteMemoryEntry,
  listMemory,
  validateMemoryInput,
  type MemoryScope,
} from "@/lib/ai-memory";

/**
 * Issue #812 §10 — the tenant-side memory manager's API.
 *
 * Three things this route refuses to do, on purpose:
 *
 *  - It will not create a `platform` row. Platform memory is Superadmin-only
 *    and lives behind `/platform/ai`, never behind a tenant permission.
 *  - It will not accept a `businessId` from the body. The tenant comes from the
 *    session, so a crafted request cannot write into another business.
 *  - It will not accept a `projectId` the member cannot reach. Project memory
 *    honours the project's own access rules, which is exactly what
 *    `requireProjectAccess` below enforces.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const scope = (new URL(request.url).searchParams.get("scope") ?? "tenant") as MemoryScope;
  if (!["tenant", "app", "project"].includes(scope)) {
    return NextResponse.json({ error: "bad_scope" }, { status: 400 });
  }

  const appKey = new URL(request.url).searchParams.get("appKey");
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (scope === "project" && !projectId) {
    return NextResponse.json({ error: "project_required" }, { status: 400 });
  }
  if (scope === "project" && projectId) {
    const access = await requireProjectAccess(session.businessId, session.sub, projectId);
    if (!access) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const entries = await listMemory({
    businessId: session.businessId,
    scope,
    appKey: scope === "app" ? appKey : null,
    projectId: scope === "project" ? projectId : null,
  });
  return NextResponse.json({ entries, maxChars: MAX_MEMORY_CHARS });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  // Writing durable memory is a management act, not a chat act: it shapes every
  // future turn for this business, so it takes `ai.manage` on top of `ai.use`.
  const guard = await requirePermission(PERMISSIONS.aiManage);
  if (guard.error) return guard.error;

  const body = (await request.json().catch(() => null)) as
    | { scope?: MemoryScope; appKey?: string | null; projectId?: string | null; content?: string }
    | null;
  const scope = body?.scope ?? "tenant";
  if (!["tenant", "app", "project"].includes(scope)) {
    return NextResponse.json({ error: "bad_scope" }, { status: 400 });
  }
  if (scope === "project" && body?.projectId) {
    const access = await requireProjectAccess(guard.session.businessId, guard.session.sub, body.projectId);
    if (!access) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const validation = validateMemoryInput({
    businessId: guard.session.businessId,
    scope,
    appKey: scope === "app" ? body?.appKey ?? null : null,
    projectId: scope === "project" ? body?.projectId ?? null : null,
    content: body?.content ?? "",
  });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const entry = await createMemoryEntry({
      businessId: guard.session.businessId,
      scope,
      appKey: scope === "app" ? body?.appKey ?? null : null,
      projectId: scope === "project" ? body?.projectId ?? null : null,
      content: body?.content ?? "",
      source: "user",
      createdBy: guard.session.sub,
    });
    return NextResponse.json({ entry }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal_error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiManage);
  if (guard.error) return guard.error;

  const body = (await request.json().catch(() => null)) as
    | { id?: string; scope?: MemoryScope; projectId?: string | null }
    | null;
  if (!body?.id) return NextResponse.json({ error: "id_required" }, { status: 400 });
  const scope = body.scope ?? "tenant";
  if (!["tenant", "app", "project"].includes(scope)) {
    return NextResponse.json({ error: "bad_scope" }, { status: 400 });
  }
  if (scope === "project" && body.projectId) {
    const access = await requireProjectAccess(guard.session.businessId, guard.session.sub, body.projectId);
    if (!access) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const removed = await deleteMemoryEntry({
    id: body.id,
    businessId: guard.session.businessId,
    scope,
  });
  if (!removed) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});

/**
 * Project access, reusing `getProject`'s own membership rule rather than a
 * second copy of it: a project is reachable by its owner, its creator, or a
 * workspace member of it — nothing else. The business id is in the same query,
 * so a cross-tenant id fails here and would fail again at RLS.
 */
async function requireProjectAccess(businessId: string, userId: string, projectId: string): Promise<boolean> {
  const { getProject } = await import("@/lib/ai-projects");
  const project = await getProject({ businessId, actorUserId: userId, projectId });
  return project !== null;
}
