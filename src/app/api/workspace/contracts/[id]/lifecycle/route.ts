import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { resolveWorkspaceSubject, transitionContract } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../../guard";

/**
 * POST { action: "complete" | "terminate" | "extend" | "renew", endDate? } —
 * a contract lifecycle transition (#761 §12). Committing the business to a
 * contractor for longer, or ending that commitment, is contract management:
 * `workspace.contracts_manage` plus `edit` on the contract as a subject.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "edit");
      const contract = await transitionContract(owner, id, String(body.action ?? ""), {
        endDate: body.endDate,
      });
      return NextResponse.json({ contract });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
