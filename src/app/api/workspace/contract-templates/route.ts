import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  archiveContractTemplate,
  listContractTemplates,
  saveContractTemplate,
} from "@/lib/contracts/service";
import { resolveWorkspaceSubject } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../guard";

/**
 * The template library the contract builder offers (issue #908): the built-in
 * starting points plus this business's own templates.
 *
 * `GET` is `workspace.view` — a member who may read contracts needs the list to
 * understand what a contract was written from.
 *
 * `POST` saves the CURRENT document of a contract as a reusable template, and
 * only `workspace.contracts_manage` + `edit` on that contract may do it: a
 * template is a document the business will issue again, and copying somebody
 * else's draft into the shared library is not a read.
 *
 * `DELETE` archives (soft): contracts already created from a template keep the
 * copy they were created with, so archiving removes a starting point and
 * nothing else.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView, request);
  if (error) return error;
  try {
    return NextResponse.json({ templates: await listContractTemplates(owner) });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage, request);
  if (error) return error;
  const body = await readBody(request);
  try {
    const contractId = body.contractId ? String(body.contractId) : "";
    if (!contractId) return NextResponse.json({ error: "contract_not_found" }, { status: 404 });
    await resolveWorkspaceSubject(owner, "contract", contractId, "edit");
    const template = await saveContractTemplate(owner, {
      name: String(body.name ?? ""),
      description: body.description === undefined ? "" : String(body.description),
      contractType: body.contractType === undefined ? undefined : String(body.contractType),
      contractId,
    });
    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage, request);
  if (error) return error;
  const templateId = new URL(request.url).searchParams.get("id") ?? "";
  try {
    await archiveContractTemplate(owner, templateId);
    return NextResponse.json({ archived: true });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
