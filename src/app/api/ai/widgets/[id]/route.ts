import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  archiveAiWidget,
  getAiWidget,
  normalizeWidgetInput,
  updateAiWidget,
} from "@/lib/ai-widgets";

async function params(context: { params: Promise<{ id: string }> }) {
  return (await context.params).id;
}

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const widget = await getAiWidget(guard.session.businessId, guard.session.sub, await params(context));
  return widget ? NextResponse.json({ widget }) : NextResponse.json({ error: "not_found" }, { status: 404 });
});

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const input = normalizeWidgetInput(body ?? {});
  if (!input) return NextResponse.json({ error: "invalid_widget" }, { status: 400 });
  try {
    const widget = await updateAiWidget(
      guard.session.businessId,
      guard.session.sub,
      await params(context),
      { ...input, pinned: typeof body?.pinned === "boolean" ? body.pinned : undefined, sortOrder: typeof body?.sortOrder === "number" ? body.sortOrder : undefined },
      guard.membership.permissions,
    );
    return widget ? NextResponse.json({ widget }) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_widget";
    return NextResponse.json({ error: code }, { status: code === "project_inaccessible" || code === "widget_permission_widening" ? 403 : 400 });
  }
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const deleted = await archiveAiWidget(guard.session.businessId, guard.session.sub, await params(context));
  return deleted ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
});
