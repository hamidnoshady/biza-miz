import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireModuleForPage } from "@/lib/industry-guard";
import { KdsBoard } from "@/app/dashboard/kitchen/kds-board";

export default async function KitchenPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "kitchen");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set<string>();
  if (!permissions.has(PERMISSIONS.kitchenView)) redirect("/dashboard");

  return <KdsBoard />;
}
