import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createContract, listContracts, contractListPage, type ContractListFilter } from "@/lib/workspace";
import { duplicateContract, ensureContractDocument } from "@/lib/contracts/service";
import type { WorkspaceContractStatus, WorkspaceContractType } from "@/lib/workspace-shared";
import { PERMISSIONS, handleWorkspaceError, readBody, pageParams, workspaceOwner } from "../guard";

/**
 * EXECUTION contracts — contractor, supplier, consultant, subcontractor,
 * vendor, developer. The relationship contracts (sales, service, partnership)
 * live in the CRM against the customer and are deliberately not reachable
 * here; see `docs/architecture/app-boundaries.md`.
 *
 * Reading runs on `workspace.view`, but WRITING runs on
 * `workspace.contracts_manage`, which is carved out of `workspace.manage`
 * precisely because recording a contract commits the business to money.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView, request);
  if (error) return error;
  const params = new URL(request.url).searchParams;
  const expiring = params.get("expiringWithinDays");
  const filter: ContractListFilter = {
    ...pageParams(params),
    projectId: params.get("projectId") ?? undefined,
    partyId: params.get("partyId") ?? undefined,
    status: (params.get("status") as WorkspaceContractStatus | "all") ?? undefined,
    contractType: (params.get("type") as WorkspaceContractType) ?? undefined,
    search: params.get("q") ?? undefined,
    expiringWithinDays: expiring !== null && Number.isFinite(Number(expiring))
      ? Math.min(Math.max(Number(expiring), 0), 365)
      : undefined,
  };
  try {
    const [contracts, { page, summary }] = await Promise.all([
      listContracts(owner, filter),
      contractListPage(owner, filter),
    ]);
    return NextResponse.json({ contracts, page, summary });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

/**
 * Create a contract — blank, from a template, or as a copy of another one
 * (issue #908).
 *
 *  - `{ ...terms }`                     a blank document titled with the contract;
 *  - `{ ...terms, templateRef }`        the document starts from a template;
 *  - `{ duplicateOf: "<contractId>" }`  a copy of that contract and its text.
 *
 * The document is created eagerly only when a starting point was named, so the
 * "open a contract I created in the quick dialog" path still creates it on
 * first read (and the unique index keeps that idempotent).
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage, request);
  if (error) return error;
  const body = await readBody(request);
  try {
    if (body.duplicateOf) {
      const contract = await duplicateContract(owner, String(body.duplicateOf), body.title as string | undefined);
      return NextResponse.json({ contract }, { status: 201 });
    }
    const contract = await createContract(owner, body);
    const templateRef = body.templateRef ? String(body.templateRef) : "";
    if (templateRef) {
      await ensureContractDocument(owner, contract, {
        templateId: templateRef.startsWith("builtin:") ? null : templateRef,
        templateKey: templateRef.startsWith("builtin:") ? templateRef.slice(8) : null,
      });
    }
    return NextResponse.json({ contract }, { status: 201 });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
