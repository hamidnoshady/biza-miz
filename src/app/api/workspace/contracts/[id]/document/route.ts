import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { readContractDocument, requireContract, saveContractDocument } from "@/lib/contracts/service";
import { resolveWorkspaceSubject } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../../guard";

/**
 * The contract's DOCUMENT — the draft body, its resolved variables, its
 * validation findings and the frozen versions behind it (issue #908).
 *
 * Reads run on `workspace.view` plus `view` on the contract as a subject;
 * writes run on `workspace.contracts_manage` (`workspace.manage` is not enough:
 * the document is the thing the business signs and pays against) and `edit` on
 * the same subject. That pair is checked here, not in the service, exactly like
 * `/api/workspace/contracts/[id]`.
 *
 * `PUT` is an optimistic-concurrency save: the client sends back the
 * `revision` it read, and a stale one is refused with 409 `document_conflict`
 * rather than merged. Two tabs therefore cannot silently overwrite each
 * other's clauses.
 */

export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView, request);
    if (error) return error;
    const { id } = await context.params;
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "view");
      const contract = await requireContract(owner, id);
      const view = await readContractDocument(owner, contract);
      // Whether the editor may save: the platform permission AND `edit` on this
      // contract — the same pair the PUT below enforces.
      let canEdit = owner.access?.canManageContracts === true;
      if (canEdit) {
        canEdit = await resolveWorkspaceSubject(owner, "contract", id, "edit").then(
          () => true,
          () => false,
        );
      }
      return NextResponse.json({ ...view, capabilities: { canEdit } });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const PUT = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage, request);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "edit");
      const contract = await requireContract(owner, id);
      const document = await saveContractDocument(owner, contract, {
        content: body.content,
        revision: Number(body.revision),
      });
      return NextResponse.json({ document });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
