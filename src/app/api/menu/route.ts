import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getMenuTree } from "@/lib/menu-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Full menu tree for the cashier POS grid and the menu management screen:
 * categories → items → attached modifier groups → modifiers.
 * Any authenticated role may read it (cashier needs it to sell).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.menuView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) {
    // «No active branch» is an empty menu, not an error — but it is the *same
    // shape* as a populated one. Dropping `itemModifierGroups` here handed the
    // client a payload `toRestaurantMenu` could not read, which is how the
    // screen ended up throwing instead of showing an empty state (#911).
    return NextResponse.json({
      categories: [],
      items: [],
      modifierGroups: [],
      modifiers: [],
      itemModifierGroups: [],
    });
  }

  return NextResponse.json(await getMenuTree(location.id));
});
