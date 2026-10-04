import { NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { projectReport } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "../guard";

/**
 * Project health and profitability. `spentRial` is read from `journal_lines`
 * through `journal_entries.project_id` — the cost-centre dimension the
 * Accounting app already owns — so the workspace never keeps a second copy of
 * a number the books are authoritative for.
 */
export const GET = withTenantScope(async () => {
  // Scoped to the projects the caller can see; `spentRial` is null unless the
  // caller may read the ledger (`ledger.view`).
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  try {
    return NextResponse.json({ rows: await projectReport(owner) });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
