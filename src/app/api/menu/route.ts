import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getMenuTree } from "@/lib/menu-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { listPromotions } from "@/lib/promotions-service";

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

  const tree = await getMenuTree(location.id);
  // Issue #913 item 4 — the till's preview must price with the same active
  // campaigns the server applies when the order is created, or the screen
  // promises one number and the confirmation quietly shows another. Only a
  // member who may create orders gets the rules (they are engine-shaped
  // config, not the management catalogue); everyone else sees the menu as
  // before.
  const selling = await requirePermission(PERMISSIONS.ordersCreate);
  if (selling.error) return NextResponse.json(tree);
  return NextResponse.json({ ...tree, promotions: await listPromotions(session.businessId, false) });
});
