import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createContract, listContracts, type ContractListFilter } from "@/lib/workspace";
import type { WorkspaceContractStatus, WorkspaceContractType } from "@/lib/workspace-shared";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../guard";

/**
 * EXECUTION contracts — contractor, supplier, consultant, subcontractor,
 * vendor, developer. The relationship contracts (sales, service, partnership)
 * live in the CRM against the customer and are deliberately not reachable
 * here; see `docs/app-boundaries.md`.
 *
 * Reading runs on `workspace.view`, but WRITING runs on
 * `workspace.contracts_manage`, which is carved out of `workspace.manage`
 * precisely because recording a contract commits the business to money.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  const params = new URL(request.url).searchParams;
  const expiring = params.get("expiringWithinDays");
  const filter: ContractListFilter = {
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
    return NextResponse.json({ contracts: await listContracts(owner, filter) });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage);
  if (error) return error;
  const body = await readBody(request);
  try {
    return NextResponse.json({ contract: await createContract(owner, body) }, { status: 201 });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
