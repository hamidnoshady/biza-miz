import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  freezeContractDocument,
  listContractDocumentVersions,
  requireContract,
} from "@/lib/contracts/service";
import { resolveWorkspaceSubject } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "../../../../guard";

/**
 * The contract's FROZEN versions (issue #908).
 *
 * `POST` freezes the current draft: it resolves every binding, refuses while a
 * required value is empty or a `{{token}}` is undefined, and writes one
 * immutable row carrying the SHA-256 of exactly what a signer would read. Once
 * written, project edits and template revisions cannot reach it — that is the
 * whole point of a version.
 *
 * Freezing is `workspace.contracts_manage` + `edit` on the contract: it is the
 * act that makes a document sendable.
 */
export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView, request);
    if (error) return error;
    const { id } = await context.params;
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "view");
      const versions = await listContractDocumentVersions(owner.businessId, id);
      return NextResponse.json({ versions });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage, request);
    if (error) return error;
    const { id } = await context.params;
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "edit");
      const contract = await requireContract(owner, id);
      const frozen = await freezeContractDocument(owner, contract);
      return NextResponse.json({
        version: {
          id: frozen.id,
          version: frozen.version,
          title: frozen.title,
          contentHash: frozen.contentHash,
          frozenAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
