/**
 * Who may be put on floor work at a branch (issue #947, consumer seam).
 *
 * ## The seam this closes
 *
 * Two doors asked «which waiters belong to this branch» and both answered from a column
 * that stopped meaning what they thought:
 *
 *   - `GET /api/staff` — the waiter list behind the floor plan's section assignment;
 *   - `floor.validWaiterId` — the write-side check when a section assignment is saved.
 *
 * They filtered `role = 'waiter' AND (location_id IS NULL OR location_id = $2)`. Since
 * migration 0170, `users.location_id` is the member's *default* branch
 * (`location_scope = 'home'`), and everything else lives on `location_scope` +
 * `user_locations` (`location-access.ts`). So a waiter given two branches read as «not
 * here» at the second one, a waiter whose policy is «none» stayed assignable at their
 * old default, and a waiter at «همهٔ شعبه‌ها» was missing from every branch but their
 * default. The floor's own picker and the floor's own validation disagreed with the
 * roster, the session and every other branch-aware read in the product.
 *
 * ## The contract
 *
 * Eligibility is three questions, answered by one predicate:
 *
 *   1. the membership is live — `is_active` *and* `membership_status` absent or
 *      `'active'`, the same test `authorize()` makes (a suspended or offboarded member
 *      is not staff any more, whichever branch they used to work in);
 *   2. the role is one of the roles the caller asks for (`waiter` for the floor);
 *   3. the branch is one the member may act in — `branchScopeSql`, the SQL twin of
 *      `accessibleLocationIds`.
 *
 * A branch that is not active, or belongs to another business, is never eligible: the
 * assignment join and the location join both carry the tenant.
 *
 * ## What this module is not
 *
 * It is not the floor's *selector*: `/api/staff` still asks for `team.manage` while the
 * floor editor next to it asks for `tables.edit`, which is #916's integration to land
 * (one coordinated change, or the picker moves behind the same capability as the editor
 * it serves). This module is only the answer to «is this member eligible here», shared
 * so the two cannot drift again — #916 consumes it rather than re-deriving it.
 */
import { query } from "./db";
import { branchScopeSql } from "./location-access";

/** The roles the floor can assign. A waiter serves sections; nobody else does (yet). */
export const FLOOR_STAFF_ROLES = ["waiter"] as const;

/**
 * The eligibility predicate for a `users` row, as SQL.
 *
 * Exported for the callers that need to *join* on eligibility (a report, a roster view)
 * rather than ask about one member; both functions below are built on it so there is
 * exactly one place where «eligible» is defined.
 */
export function staffEligibilitySql(options: {
  /** The alias of the `users` row being tested. */
  alias: string;
  /** Placeholder for the business id, e.g. `$1`. */
  businessParam: string;
  /** Placeholder for the branch id, e.g. `$2`. */
  locationParam: string;
  /** Roles that count as staff for the caller's question. */
  roles?: readonly string[];
}): string {
  const { alias, businessParam, locationParam, roles = FLOOR_STAFF_ROLES } = options;
  const roleList = roles.map((role) => `'${role.replace(/'/g, "''")}'`).join(", ");
  return `${alias}.business_id = ${businessParam}
      AND ${alias}.is_active
      AND (${alias}.membership_status IS NULL OR ${alias}.membership_status = 'active')
      AND ${alias}.role::text IN (${roleList})
      AND ${branchScopeSql({ alias, locationParam })}`;
}

/** One eligible member, in the shape the floor's pickers render. */
export interface EligibleStaffMember {
  id: string;
  fullName: string;
}

/**
 * The members eligible to be assigned floor work at one branch.
 *
 * `locations` is joined rather than trusted: a caller that passes a location id from
 * another business (or an archived branch) gets an empty list, never a cross-tenant
 * roster.
 */
export async function listEligibleStaffAtLocation(
  businessId: string,
  locationId: string,
  roles: readonly string[] = FLOOR_STAFF_ROLES,
): Promise<EligibleStaffMember[]> {
  const { rows } = await query<{ id: string; full_name: string }>(
    `SELECT u.id, u.full_name
       FROM users u
       JOIN locations l ON l.id = $2 AND l.business_id = $1 AND l.is_active
      WHERE ${staffEligibilitySql({ alias: "u", businessParam: "$1", locationParam: "$2", roles })}
      ORDER BY u.full_name, u.id`,
    [businessId, locationId],
  );
  return rows.map((row) => ({ id: row.id, fullName: row.full_name }));
}

/**
 * May this member be assigned floor work at this branch?
 *
 * The write-side half of the same contract — what `floor.validWaiterId` asks before a
 * section assignment is saved. Answering it any other way is how a waiter the picker
 * never offered ended up holding a section.
 */
export async function isEligibleStaffAtLocation(
  businessId: string,
  locationId: string,
  userId: string,
  roles: readonly string[] = FLOOR_STAFF_ROLES,
): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `SELECT u.id
       FROM users u
       JOIN locations l ON l.id = $2 AND l.business_id = $1 AND l.is_active
      WHERE u.id = $3
        AND ${staffEligibilitySql({ alias: "u", businessParam: "$1", locationParam: "$2", roles })}`,
    [businessId, locationId, userId],
  );
  return rows.length > 0;
}
