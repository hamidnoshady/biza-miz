import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { hasCapability } from "@/lib/industry-profile";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isRetailCatalogueIndustry, type RetailCatalogueIndustry } from "@/lib/industries";
import {
  catalogueAdapterFor,
  isProductWorkspaceIndustry,
  productApiBaseFor,
  type ProductWorkspaceIndustry,
} from "@/lib/product-workspace";

/**
 * The shared server-side door of every products-workspace page: inventory
 * visibility and the trade-goods industry set, then the trade's own
 * items/stock API prefix. Product catalog writes require `inventory.adjust`
 * (which implies `inventory.view`) on both the page and API. `draftScope`
 * keeps local add-product drafts isolated by business and branch on shared
 * devices.
 */
export async function requireProductWorkspace(options: { edit?: boolean } = {}): Promise<{
  industry: ProductWorkspaceIndustry;
  apiBase: string;
  draftScope: string;
  canEdit: boolean;
  canImport: boolean;
  canEditMeta: boolean;
  canManageStore: boolean;
  canViewWeightTemplates: boolean;
}> {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const requiredPermission = options.edit ? PERMISSIONS.inventoryAdjust : PERMISSIONS.inventoryView;
  if (!access?.isActive || !access.permissions.has(requiredPermission)) redirect("/accounting/overview");
  const industry = await getBusinessIndustry(session.businessId);
  if (!isProductWorkspaceIndustry(industry)) redirect("/accounting/overview");
  const draftLocation = session.activeLocationId ?? session.locationId ?? "default-location";
  return {
    industry,
    apiBase: productApiBaseFor(industry),
    draftScope: `${session.businessId}:${draftLocation}`,
    canEdit: access.permissions.has(PERMISSIONS.inventoryAdjust),
    canImport: access.permissions.has(PERMISSIONS.dataImport),
    canEditMeta: access.permissions.has(PERMISSIONS.inventoryAdjust) && access.permissions.has(PERMISSIONS.menuEdit),
    canManageStore: access.permissions.has(PERMISSIONS.inventoryAdjust) && access.permissions.has(PERMISSIONS.integrationsManage),
    canViewWeightTemplates: access.permissions.has(PERMISSIONS.menuView),
  };
}

/** Resolve a native specialist for the shared list without granting variant API access. */
export async function specialistCatalogueForPage(): Promise<{
  industry: "jewelry" | "watch" | "automotive";
  canEdit: boolean;
} | null> {
  const session = await getSession();
  if (!session) redirect("/login");
  const industry = await getBusinessIndustry(session.businessId);
  const adapter = catalogueAdapterFor(industry);
  if (adapter?.kind !== "specialist" || (industry !== "jewelry" && industry !== "watch" && industry !== "automotive")) return null;
  const access = await memberAccessFor(session);
  if (!access?.isActive || !access.permissions.has(adapter.readPermission)) redirect("/accounting/overview");
  return { industry, canEdit: access.permissions.has(industry === "automotive" ? PERMISSIONS.vehiclesCreate : PERMISSIONS.inventoryAdjust) };
}

/** Only expose specialist sections with a real native implementation. */
export async function specialistSectionForPage(section: "prices" | "reports"): Promise<{ industry: "jewelry" | "watch"; canEdit: boolean } | null> {
  const session = await getSession();
  if (!session) redirect("/login");
  const industry = await getBusinessIndustry(session.businessId);
  if (!(section === "prices" && industry === "jewelry") && !(section === "reports" && (industry === "watch" || industry === "jewelry"))) return null;
  const access = await memberAccessFor(session);
  if (!access?.isActive || !access.permissions.has(PERMISSIONS.inventoryView) || (section === "reports" && !access.permissions.has(PERMISSIONS.reportsView))) redirect("/accounting/overview");
  return { industry: industry as "jewelry" | "watch", canEdit: access.permissions.has(PERMISSIONS.inventoryAdjust) };
}

/** Automotive prices and stock reporting use the dealership's permissions. */
export async function automotiveProductSectionForPage(section: "prices" | "reports"): Promise<{ canEdit: boolean; canSeeCost: boolean } | null> {
  const session = await getSession();
  if (!session) redirect("/login");
  const industry = await getBusinessIndustry(session.businessId);
  if (industry !== "automotive") return null;
  const access = await memberAccessFor(session);
  if (!access?.isActive || !access.permissions.has(PERMISSIONS.vehiclesView) ||
      (section === "reports" && !access.permissions.has(PERMISSIONS.reportsView))) redirect("/accounting/overview");
  return { canEdit: access.permissions.has(PERMISSIONS.vehiclesPriceEdit), canSeeCost: access.permissions.has(PERMISSIONS.vehiclesCostView) };
}

/** New native weighted pieces and watch models use the same permission as their APIs. */
export async function specialistCreateEntry(): Promise<{
  industry: "jewelry" | "watch";
  draftScope: string;
  locationId: string;
  locationName: string;
} | null> {
  const session = await getSession();
  if (!session) redirect("/login");
  const industry = await getBusinessIndustry(session.businessId);
  if (industry !== "jewelry" && industry !== "watch") return null;
  const access = await memberAccessFor(session);
  if (!access?.isActive || !access.permissions.has(PERMISSIONS.inventoryView) || !access.permissions.has(PERMISSIONS.inventoryAdjust)) redirect("/accounting/overview");
  const location = await resolveActiveLocation(session);
  if (!location) redirect("/accounting/overview");
  return { industry, draftScope: `${session.businessId}:${session.sub}:${location.id}`, locationId: location.id, locationName: location.name };
}

/** Vehicle creation has its own permission, not the variant inventory grant. */
export async function automotiveCreateEntry(): Promise<boolean> {
  const session = await getSession();
  if (!session) redirect("/login");
  const industry = await getBusinessIndustry(session.businessId);
  if (industry !== "automotive") return false;
  const access = await memberAccessFor(session);
  if (!access?.isActive || !access.permissions.has(PERMISSIONS.vehiclesView) || !access.permissions.has(PERMISSIONS.vehiclesCreate)) redirect("/accounting/overview");
  return true;
}

/** Label templates use the existing printing catalogue, not variant or
 * weight-barcode APIs. Keep the native catalogue permission for each trade
 * and let printing endpoints enforce settings/print permissions separately. */
export async function requireRetailLabels(): Promise<{
  industry: RetailCatalogueIndustry;
  canManage: boolean;
  canPrint: boolean;
  canAssignBarcode: boolean;
  locationId: string | null;
  canViewLegacyWeight: boolean;
  canEditLegacyWeight: boolean;
}> {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const industry = await getBusinessIndustry(session.businessId);
  const adapter = catalogueAdapterFor(industry);
  if (!isRetailCatalogueIndustry(industry) || !adapter || !hasCapability(industry, "barcode")) redirect("/accounting/overview");
  const readPermission = adapter.kind === "specialist" ? adapter.readPermission : PERMISSIONS.inventoryView;
  if (!access?.isActive || !access.permissions.has(readPermission)) redirect("/accounting/overview");
  return {
    industry,
    canManage: access.permissions.has(PERMISSIONS.settingsManage),
    canPrint: access.permissions.has(PERMISSIONS.printingExecute),
    canAssignBarcode: (industry === "jewelry" || industry === "watch") && access.permissions.has(PERMISSIONS.inventoryAdjust),
    locationId: (await resolveActiveLocation(session))?.id ?? null,
    canViewLegacyWeight: adapter.kind === "variants" && access.permissions.has(PERMISSIONS.menuView),
    canEditLegacyWeight: adapter.kind === "variants" && access.permissions.has(PERMISSIONS.menuView) && access.permissions.has(PERMISSIONS.menuEdit) && access.permissions.has(PERMISSIONS.inventoryAdjust),
  };
}
