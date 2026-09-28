import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { listConversations, listConversationsByProject } from "@/lib/ai-conversations";

const DEFAULT_LIMIT = 30;

function parseBefore(raw: string | null): string | null {
  if (!raw) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/**
 * A member's own AI conversations, most recently active first. Ownership
 * (not role) is the access control here — see ai-conversations.ts.
 *
 * `?project=<id>` narrows the list to one project's threads, scoped in SQL
 * rather than fetched-then-filtered — so a project with more threads than the
 * page limit no longer silently loses the older ones.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LIMIT;
  const before = parseBefore(url.searchParams.get("before"));
  const projectId = url.searchParams.get("project");
  // Dashboard history is intentionally mode-scoped; old wizard/floor threads
  // must not appear as if they were compatible with this workspace.
  const mode = url.searchParams.get("mode") === "floor" ? "floor" : "dashboard";

  const conversations = projectId
    ? await listConversationsByProject(
        { businessId: session.businessId, actorUserId: session.sub, projectId },
        { limit, before, mode },
      )
    : await listConversations(
        { businessId: session.businessId, actorUserId: session.sub },
        { limit, before, mode },
      );
  return NextResponse.json({ conversations });
});
