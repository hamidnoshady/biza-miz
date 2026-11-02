import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { applyContractTemplate, readContractDocument, requireContract } from "@/lib/contracts/service";
import { resolveWorkspaceSubject } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../../../guard";

/**
 * `POST { templateRef }` — replace the DRAFT body with a template's content
 * (issue #908).
 *
 * `templateRef` is `builtin:<key>` for a starter or a `contract_templates` id
 * for the business's own. The service copies the content, so the template and
 * the contract are independent from that point on.
 *
 * Allowed while a signing round is live: a sender may prepare the next round.
 * The live round keeps pointing at the version it froze, and the panel shows
 * «سند پس از ارسال تغییر کرده است» — editing never reaches a signer who is
 * mid-flight.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage, request);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "edit");
      const contract = await requireContract(owner, id);
      await applyContractTemplate(owner, contract, String(body.templateRef ?? ""));
      return NextResponse.json(await readContractDocument(owner, contract));
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
