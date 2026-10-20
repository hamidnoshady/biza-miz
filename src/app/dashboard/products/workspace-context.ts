import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { getBusinessIndustry } from "@/lib/industry-guard";
import {
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
}> {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const requiredPermission = options.edit ? PERMISSIONS.inventoryAdjust : PERMISSIONS.inventoryView;
  if (!access || !access.permissions.has(requiredPermission)) redirect("/accounting/overview");
  const industry = await getBusinessIndustry(session.businessId);
  if (!isProductWorkspaceIndustry(industry)) redirect("/accounting/overview");
  const draftLocation = session.activeLocationId ?? session.locationId ?? "default-location";
  return {
    industry,
    apiBase: productApiBaseFor(industry),
    draftScope: `${session.businessId}:${draftLocation}`,
    canEdit: access.permissions.has(PERMISSIONS.inventoryAdjust),
  };
}
