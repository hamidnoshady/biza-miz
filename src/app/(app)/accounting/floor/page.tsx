import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireFeatureForPage } from "@/lib/features";
import { requireModuleForPage } from "@/lib/industry-guard";
import { FloorPlan } from "@/app/dashboard/floor/floor-plan";

export default async function FloorPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "tables");
  await requireFeatureForPage(session.businessId, "reservations");

  const access = await memberAccessFor(session);
  // The page is a read/operations surface just like GET /api/floor, whereas
  // the canvas editor and its structural mutations still require tables.edit.
  if (!access?.isActive || !access.permissions.has(PERMISSIONS.tablesManage)) redirect("/dashboard");
  return <FloorPlan canEdit={access.permissions.has(PERMISSIONS.tablesEdit)} />;
}
