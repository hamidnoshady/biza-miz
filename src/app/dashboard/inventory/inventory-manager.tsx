"use client";

/**
 * The one client entry point for the canonical inventory workspace.
 *
 * Every industry now opens `/accounting/inventory` and renders this manager.
 * The two adapters only protect the deliberately distinct record models and
 * posting rules: food service works with `inventory_items`, while retail works
 * with `items` / batches. They are not alternate routes, nav entries, or
 * independently mounted inventory applications.
 */
import { FoodServiceInventoryManager } from "./food-service-inventory-manager";
import { RetailInventoryManager } from "./retail-inventory-manager";
import type { InventoryWorkspaceModel } from "@/lib/inventory-workspace";

// The food-service panels share these contracts through the public manager
// module. Re-exporting preserves that internal boundary while the rendered
// manager now selects the appropriate industry adapter.
export type {
  InventoryItem,
  MenuItemRef,
  ModifierRecipeLink,
  ModifierRef,
  RecipeLink,
  Runner,
  Supplier,
} from "./food-service-inventory-manager";

export function InventoryManager({
  role,
  model,
  permissions,
}: {
  role: string;
  model: InventoryWorkspaceModel;
  /** The member's effective permission keys — the suppliers list's buttons follow them. */
  permissions?: readonly string[];
}) {
  return model === "retail" ? (
    <RetailInventoryManager permissions={permissions} />
  ) : (
    <FoodServiceInventoryManager role={role} permissions={permissions} />
  );
}
