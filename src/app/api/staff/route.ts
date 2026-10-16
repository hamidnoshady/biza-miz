import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { listEligibleStaffAtLocation } from "@/lib/staff-eligibility";

/**
 * Active waiters at this location — for section assignment on the floor plan.
 *
 * Issue #947 (consumer seam) — «waiters at this location» is now
 * `listEligibleStaffAtLocation`, the same contract the write-side check uses
 * (`floor.validWaiterId`). It used to be `location_id IS NULL OR location_id = $2`,
 * which reads `users.location_id` as if it were still the member's only branch; since
 * migration 0170 that column is the member's *default* branch and the access set lives
 * on `location_scope` + `user_locations`. The `team.manage` gate stays for now — the
 * floor's own selector and its editor disagree about capabilities, and that
 * reconciliation belongs to #916, which consumes this module rather than re-deriving
 * the rule.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ waiters: [] });

  const waiters = await listEligibleStaffAtLocation(session.businessId, location.id);
  // The wire shape is unchanged: `{ id, full_name }`, the columns the floor renders.
  return NextResponse.json({
    waiters: waiters.map((waiter) => ({ id: waiter.id, full_name: waiter.fullName })),
  });
});
