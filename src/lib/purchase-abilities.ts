/**
 * Issue #915 — whether the signed-in member may *mutate* purchases (create a
 * draft/receipt, order, receive, cancel, delete, return to supplier). Both
 * inventory workspaces' «خرید» sections consult this before rendering their
 * mutation controls, so the screen matches the API: every purchase mutation
 * route requires `purchases.manage` (`requirePermission`), and a button that
 * only ever answers 403 is a trap, not a capability.
 *
 * Same resolution rule as `partiesSectionAbilities` (parties-scopes.ts): the
 * member's effective permissions decide when the mounting page supplies them;
 * only when it cannot (an older mount with no list) do the built-in role
 * presets answer. The fallback mirrors `ROLE_PRESETS` in permissions.ts —
 * `purchases.manage` ships in the owner rule, admin and manager presets.
 *
 * Framework-free so it is unit-testable and importable from client components.
 */
import { PERMISSIONS } from "./permissions";

const PURCHASES_PRESET_MANAGING_ROLES = ["owner", "admin", "manager"];

export function canManagePurchases(role: string, permissions?: readonly string[] | null): boolean {
  return permissions !== undefined && permissions !== null
    ? permissions.includes(PERMISSIONS.purchasesManage)
    : PURCHASES_PRESET_MANAGING_ROLES.includes(role);
}
