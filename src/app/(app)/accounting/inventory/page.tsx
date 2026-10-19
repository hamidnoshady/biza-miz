import { resolveActiveLocation } from "@/lib/setup-state";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireFeatureForPage } from "@/lib/features";
import {
  getBusinessIndustry,
  requireModuleForPage,
} from "@/lib/industry-guard";
import { hasModule } from "@/lib/industry-profile";
import {
  inventoryModuleForWorkspace,
  inventoryWorkspaceModel,
} from "@/lib/inventory-workspace";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { InventoryManager } from "@/app/dashboard/inventory/inventory-manager";

/**
 * The single inventory door for every industry.
 *
 * Hospitality and retail have different stock records (`inventory_items` and
 * `items`) and posting safeguards, so the appropriate data adapter remains in
 * place. They no longer have competing user-facing URLs or sidebar entries:
 * every business opens this canonical inventory workspace.
 */
export default async function InventoryPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const [industry, member] = await Promise.all([
    getBusinessIndustry(session.businessId),
    memberAccessFor(session),
  ]);
  if (!member?.isActive || !member.permissions.has("inventory.view")) redirect("/dashboard");
  const model = inventoryWorkspaceModel(
    Boolean(industry && hasModule(industry, "inventory")),
  );
  await requireModuleForPage(
    session.businessId,
    inventoryModuleForWorkspace(model),
  );
  if (model === "food-service")
    await requireFeatureForPage(session.businessId, "inventory");

  const location = await resolveActiveLocation(session);
  return (
    <PageShell>
      <PageHeader
        title="انبار"
        description="انبارها، موجودی، انبارگردانی، رسید و حواله، خرید و عملیات کالا در یک مسیر واحد."
        actions={<KnowledgeHelpButton section="inventory" />}
      />
      <InventoryManager
        key={location?.id ?? "no-location"}
        role={member?.role ?? session.role}
        model={model}
        requestScope={`${session.businessId}:${session.sub}:${location?.id ?? "no-location"}`}
        permissions={member ? [...member.permissions] : undefined}
      />
    </PageShell>
  );
}
