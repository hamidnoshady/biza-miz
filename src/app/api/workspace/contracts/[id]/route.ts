import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteContract,
  getContract,
  listApprovals,
  listComments,
  listDocuments,
  resolveWorkspaceSubject,
  updateContract,
} from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../guard";

/**
 * One execution contract with its documents, approvals and comments.
 *
 * Every verb resolves the contract as a workspace subject first: `view` to
 * read, `edit` to amend or delete — on its project when it has one, and for a
 * business-level contract by authorship, contract-manager permission or an
 * administrator override.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "view");
      const contract = await getContract(owner.businessId, id);
      if (!contract) return NextResponse.json({ error: "contract_not_found" }, { status: 404 });
      const [documents, approvals, comments] = await Promise.all([
        listDocuments(owner, { contractId: id }),
        listApprovals(owner, { subjectType: "contract", subjectId: id }),
        listComments(owner.businessId, "contract", id),
      ]);
      return NextResponse.json({ contract, documents, approvals, comments });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "edit");
      const contract = await updateContract(owner, id, body);
      if (!contract) return NextResponse.json({ error: "contract_not_found" }, { status: 404 });
      return NextResponse.json({ contract });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "edit");
      return NextResponse.json({ deleted: await deleteContract(owner.businessId, id) });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
