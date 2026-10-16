import { NextRequest, NextResponse } from "next/server";
import { requireFloorAssistant, requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listConversations, listConversationsByProject } from "@/lib/ai-conversations";
import type { AgentMode } from "@/lib/ai";

const MODES: readonly AgentMode[] = ["dashboard", "floor", "wizard"];

function parseBefore(raw: string | null): string | null {
  if (!raw) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/**
 * List the caller's own conversations for the active surface (`mode=dashboard`
 * by default).
 *
 * Transcript access policy (Issue #905 §10):
 * - Requires active membership and the surface's assistant capability
 *   (`PERMISSIONS.aiUse` for dashboard/wizard, `requireFloorAssistant()`
 *   for floor), which re-reads membership through `authorize()`. Revoking
 *   `ai.use` / floor assistant access or deactivating a member immediately
 *   revokes transcript access on the next request.
 * - Scoped by `(business_id = session.businessId, actor_user_id = session.sub)`
 *   inside `withTenantScope` so a member never sees another member's or
 *   another business's conversations.
 * - Supports server-side `q` search (matching title or message content) and
 *   compound cursor pagination (`before` + `beforeId`).
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const rawMode = searchParams.get("mode");
  const mode: AgentMode =
    rawMode && (MODES as readonly string[]).includes(rawMode) ? (rawMode as AgentMode) : "dashboard";

  const guard =
    mode === "floor"
      ? await requireFloorAssistant()
      : await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const session = guard.session;

  const before = parseBefore(searchParams.get("before"));
  const beforeId = searchParams.get("beforeId");
  const q = searchParams.get("q");
  const rawLimit = Number(searchParams.get("limit") ?? 30);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.max(1, Math.min(50, Math.floor(rawLimit)))
    : 30;
  const projectId = searchParams.get("project")?.trim() || null;

  const fetchLimit = limit + 1;
  const rows = projectId
    ? await listConversationsByProject(
        { businessId: session.businessId, actorUserId: session.sub, projectId },
        { mode, before, beforeId, query: q, limit: fetchLimit },
      )
    : await listConversations(
        { businessId: session.businessId, actorUserId: session.sub },
        { mode, before, beforeId, query: q, limit: fetchLimit },
      );

  const hasMore = rows.length > limit;
  const conversations = hasMore ? rows.slice(0, limit) : rows;
  const last = conversations[conversations.length - 1];
  const nextCursor =
    hasMore && last
      ? { before: last.lastMessageAt, beforeId: last.id }
      : null;

  return NextResponse.json({ conversations, hasMore, nextCursor });
});
