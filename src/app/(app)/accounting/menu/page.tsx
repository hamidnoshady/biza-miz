import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { MenuWorkspace } from "./menu-workspace";

/**
 * The canonical café/restaurant menu manager — issue #844.
 *
 * «مدیریت منو» lives under Accounting → «فروش و درآمد», right after the till.
 * The route is gated by the `menu` module server-side, and the read gate
 * (`menu.view`) is checked here; mutations are gated `menu.edit` on every
 * API route and hidden from the UI through the `canEdit` prop below, so
 * navigation, page and server APIs answer to the same two capabilities.
 *
 * `/settings/menu` (and the old `/dashboard/menu`) are middleware 308s to
 * this page — there is no second menu screen to drift.
 */
export default async function MenuPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "menu");

  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set<string>();
  if (!permissions.has(PERMISSIONS.menuView)) redirect("/accounting");

  return <MenuWorkspace canEdit={permissions.has(PERMISSIONS.menuEdit)} />;
}
