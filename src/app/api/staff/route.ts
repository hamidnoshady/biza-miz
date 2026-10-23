import { NextResponse } from "next/server";
import { withTenantScope, requirePermission, requireAnyPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listAssignableFloorStaff } from "@/lib/floor";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Active staff eligible for floor section assignment at this location.
 *
 * Issue #916 (Findings 5, 19, 20):
 *   - Accessible to holders of `tables.edit`, `tables.manage`, or `team.manage` so
 *     managers/floor leads with `tables.edit` can load the section staff picker
 *     without requiring full HR `team.manage`.
 *   - Uses `listAssignableFloorStaff`, which includes branch-eligible `waiter` and
 *     `cashier` roles (`ASSIGNABLE_FLOOR_STAFF_ROLES`) plus active custom-role members
 *     who hold `tables.manage` or `orders.create`.
 */
export const GET = withTenantScope(async () => {
  const teamGuard = await requirePermission(PERMISSIONS.teamManage);
  const { session, error } = teamGuard.error
    ? await requireAnyPermission("tables.edit", "tables.manage")
    : teamGuard;
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ waiters: [], staff: [] });

  const staff = await listAssignableFloorStaff(session.businessId, location.id);
  const items = staff.map((member) => ({
    id: member.id,
    full_name: member.full_name,
    role: member.role ?? "waiter",
  }));
  return NextResponse.json({
    waiters: items,
    staff: items,
  });
});
