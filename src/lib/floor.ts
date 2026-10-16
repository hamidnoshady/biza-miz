/** Small server-side helpers for the floor plan (DB-touching). */
import { query } from "./db";
import { isEligibleStaffAtLocation } from "./staff-eligibility";

/**
 * Validate an optional waiter id for a section assignment, scoped to this
 * location. Returns the id (assign), null (clear), or false (invalid id).
 *
 * Issue #947 (consumer seam) — the check is `isEligibleStaffAtLocation`, the same
 * contract `GET /api/staff` lists from. It used to be `location_id IS NULL OR
 * location_id = $2`, i.e. the member's *default* branch since migration 0170, so a
 * waiter the picker never offered could still be written into a section — and a waiter
 * whose policy is «none» (no branch at all) stayed assignable at their old one.
 */
export async function validWaiterId(
  businessId: string,
  locationId: string,
  waiterId: string | null | undefined,
): Promise<string | null | false> {
  if (!waiterId) return null;
  const eligible = await isEligibleStaffAtLocation(businessId, locationId, waiterId);
  return eligible ? waiterId : false;
}

/**
 * Validate an optional section id for a table, scoped to this location.
 * Returns the id (assign), null (unassign), or false (invalid).
 */
export async function resolveSectionId(
  locationId: string,
  sectionId: string | null | undefined,
): Promise<string | null | false> {
  if (!sectionId) return null;
  const { rows } = await query("SELECT id FROM floor_sections WHERE id = $1 AND location_id = $2", [
    sectionId,
    locationId,
  ]);
  return rows.length > 0 ? sectionId : false;
}
