import { redirect } from "next/navigation";
import { workspaceAccessFor, type WorkspaceAccessDecision } from "./workspace-access";

/**
 * Page gate for every `/workspace` surface (issue #1110).
 *
 * Deliberately separate from `workspace-access.ts`: API routes, the AI tool
 * executor and the MCP server need the decision but must not pull
 * `next/navigation` into their bundles, and the visual size gate measures that
 * duplication. Only server-rendered Workspace pages import this file.
 *
 * An unavailable business is sent to the assistant home — the platform's
 * accessible home — rather than shown an empty or padlocked Workspace.
 */
export async function requireWorkspacePageAccess(
  businessId: string,
  permissions: ReadonlySet<string> | readonly string[],
): Promise<WorkspaceAccessDecision> {
  const access = await workspaceAccessFor(businessId, permissions);
  if (!access.available) redirect("/dashboard");
  return access;
}
