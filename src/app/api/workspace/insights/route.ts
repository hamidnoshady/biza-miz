import { NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { workspaceInsights } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "../guard";

/**
 * GET — the Reports page's questions (#761 §15), answered over the projects
 * the caller can see; overspend only for a ledger reader. Read-only.
 */
export const GET = withTenantScope(async () => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  try {
    return NextResponse.json({ insights: await workspaceInsights(owner) });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
