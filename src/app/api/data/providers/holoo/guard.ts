import { NextResponse } from "next/server";
import { memberAccessFor } from "@/lib/member-access";
import { accessibleLocationsFor } from "@/lib/setup-state";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { isIndustry, type Industry } from "@/lib/industries";
import { industryProfile } from "@/lib/industry-profile";
import { PERMISSIONS } from "@/lib/permissions";
import { dataOwner, PERMISSIONS as DATA_PERMISSIONS, type DataOwner } from "../../guard";

export async function holooTransferOwner(
  permission: (typeof DATA_PERMISSIONS)["dataImport"] | (typeof DATA_PERMISSIONS)["dataExport"] = DATA_PERMISSIONS.dataImport,
): Promise<{ owner: DataOwner; error: null } | { owner: null; error: NextResponse }> {
  const { owner, error } = await dataOwner(permission);
  if (error) return { owner: null, error };
  const access = await memberAccessFor(owner.session);
  if (!access?.isActive || !access.permissions.has(PERMISSIONS.integrationsView)) {
    return { owner: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { owner, error: null };
}

export async function holooProviderReadOwner(): Promise<{ owner: DataOwner; error: null } | { owner: null; error: NextResponse }> {
  const importer = await holooTransferOwner(DATA_PERMISSIONS.dataImport);
  if (importer.owner) return importer;
  return holooTransferOwner(DATA_PERMISSIONS.dataExport);
}

export interface HolooLocationAccess {
  locationIds: Set<string>;
  canAccessUnboundConnection: boolean;
}

export async function holooLocationAccess(owner: DataOwner): Promise<HolooLocationAccess> {
  const accessible = await accessibleLocationsFor(owner.session);
  return {
    locationIds: new Set(accessible.locations.map((location) => location.id)),
    canAccessUnboundConnection: accessible.locations.length === accessible.businessLocationCount,
  };
}

export function canAccessHolooConnectionLocation(access: HolooLocationAccess, connectionLocationId: string | null): boolean {
  return connectionLocationId
    ? access.locationIds.has(connectionLocationId)
    : access.canAccessUnboundConnection;
}

function industryFor(value: string | null): Industry {
  return isIndustry(value ?? "") ? value as Industry : "food_service";
}

function requirementsFor(industry: Industry): Record<string, string[]> {
  const goodsPermission = industryProfile(industry).salesModel === "order_ticket"
    ? PERMISSIONS.menuEdit
    : PERMISSIONS.inventoryAdjust;
  return {
    goods: [goodsPermission],
    // A Holoo person table can carry both customer and supplier roles.
    persons: [PERMISSIONS.partiesManage, PERMISSIONS.purchasesManage],
    accounts: [PERMISSIONS.accountsEdit],
    // Opening inventory posts a stock event and its canonical ledger entry.
    openingInventory: [PERMISSIONS.inventoryAdjust, PERMISSIONS.ledgerPost],
    journal: [PERMISSIONS.ledgerPost],
    journalLines: [PERMISSIONS.ledgerPost],
  };
}

function exportRequirementsFor(industry: Industry): Record<string, string[]> {
  const goodsPermission = industryProfile(industry).salesModel === "order_ticket"
    ? PERMISSIONS.menuView
    : PERMISSIONS.inventoryView;
  return {
    goods: [goodsPermission],
    // The export combines customer and supplier contacts so the workbook does
    // not silently omit either party role.
    persons: [PERMISSIONS.partiesView, PERMISSIONS.crmExport, PERMISSIONS.purchasesManage],
    accounts: [PERMISSIONS.ledgerView],
  };
}

export async function availableHolooScopes(owner: DataOwner): Promise<string[]> {
  const [industry, access] = await Promise.all([
    getBusinessIndustry(owner.businessId),
    memberAccessFor(owner.session),
  ]);
  const granted = access?.permissions ?? new Set<string>();
  return Object.entries(requirementsFor(industryFor(industry)))
    .filter(([, required]) => required.every((permission) => granted.has(permission)))
    .map(([scope]) => scope);
}

export async function availableHolooExportScopes(owner: DataOwner): Promise<string[]> {
  const [industry, access] = await Promise.all([
    getBusinessIndustry(owner.businessId),
    memberAccessFor(owner.session),
  ]);
  const granted = access?.permissions ?? new Set<string>();
  return Object.entries(exportRequirementsFor(industryFor(industry)))
    .filter(([, required]) => required.every((permission) => granted.has(permission)))
    .map(([scope]) => scope);
}

async function checkScopePermissions(
  owner: DataOwner,
  scopes: readonly string[],
  requirements: (industry: Industry) => Record<string, string[]>,
): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const businessIndustry = await getBusinessIndustry(owner.businessId);
  const access = await memberAccessFor(owner.session);
  const granted = access?.permissions ?? new Set<string>();
  const requiredByScope = requirements(industryFor(businessIndustry));
  const missing = scopes.flatMap((scope) =>
    (requiredByScope[scope] ?? ["data_transfer.unsupported_scope"]).filter((permission) => !granted.has(permission)),
  );
  return missing.length ? { ok: false, missing: [...new Set(missing)] } : { ok: true };
}

export function checkHolooScopePermissions(owner: DataOwner, scopes: readonly string[]) {
  return checkScopePermissions(owner, scopes, requirementsFor);
}

export function checkHolooExportScopePermissions(owner: DataOwner, scopes: readonly string[]) {
  return checkScopePermissions(owner, scopes, exportRequirementsFor);
}

export async function canManageHolooConnections(owner: DataOwner): Promise<boolean> {
  const access = await memberAccessFor(owner.session);
  return Boolean(access?.permissions.has(PERMISSIONS.integrationsManage));
}

export async function canUseHolooDataExport(owner: DataOwner): Promise<boolean> {
  const access = await memberAccessFor(owner.session);
  return Boolean(access?.permissions.has(DATA_PERMISSIONS.dataExport));
}

export async function canUseHolooDataImport(owner: DataOwner): Promise<boolean> {
  const access = await memberAccessFor(owner.session);
  return Boolean(access?.permissions.has(DATA_PERMISSIONS.dataImport));
}

const CONNECTED_SEND_PERMISSIONS = [
  PERMISSIONS.integrationsManage,
  PERMISSIONS.ordersView,
  PERMISSIONS.purchasesManage,
  PERMISSIONS.financeReceivablesManage,
  PERMISSIONS.financePayablesManage,
];

export async function canSendHolooDocuments(owner: DataOwner): Promise<boolean> {
  const access = await memberAccessFor(owner.session);
  return Boolean(access?.isActive && CONNECTED_SEND_PERMISSIONS.every((permission) => access.permissions.has(permission)));
}

export async function checkHolooConnectedSendPermissions(owner: DataOwner): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const access = await memberAccessFor(owner.session);
  const granted = access?.permissions ?? new Set<string>();
  const missing = CONNECTED_SEND_PERMISSIONS.filter((permission) => !granted.has(permission));
  return missing.length ? { ok: false, missing } : { ok: true };
}
