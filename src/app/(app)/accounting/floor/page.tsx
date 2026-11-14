import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireAnyFeatureForPage } from "@/lib/features";
import { requireModuleForPage } from "@/lib/industry-guard";
import { FloorPlan } from "@/app/dashboard/floor/floor-plan";

export default async function FloorPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "tables");
  // Table service is `dine_in` or `reservations` (ESH-147): a café that prints
  // a QR per table but takes no bookings still needs its own floor.
  await requireAnyFeatureForPage(session.businessId, ["dine_in", "reservations"]);

  const access = await memberAccessFor(session);
  // The page is a read/operations surface just like GET /api/floor, whereas
  // the canvas editor and its structural mutations still require tables.edit.
  if (!access?.isActive || !access.permissions.has(PERMISSIONS.tablesManage)) redirect("/dashboard");
  return <FloorPlan canEdit={access.permissions.has(PERMISSIONS.tablesEdit)} />;
}
