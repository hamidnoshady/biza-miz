/**
 * Issue #933 item 6 — which branch does a shift belong to, in SQL?
 *
 * `employee_shifts.location_id` is nullable: rows written before `openShift`
 * recorded a fallback branch have none. The predicates used to say
 * `location_id = $1 OR location_id IS NULL`, which attributed *every* legacy
 * shift to *every* branch — so one branch's forgotten cash-up could hold
 * another branch's live window open, and a shift picker offered rows that
 * belonged somewhere else.
 *
 * Migration 0233 adds `app_shift_attribution_branch(business, location,
 * employee)`, which resolves a branch-less row to the one branch it can be
 * attributed to (the employee's home branch, their only assigned branch, or the
 * business's only branch) and to NULL — an explicit unknown — otherwise. This
 * module is the one place those queries build that expression, so the shift
 * list, the business-day status, the orders screen and the shift-orders report
 * cannot drift into three different definitions of "this branch's shifts".
 *
 * Framework-free and unit-tested in shift-branch-scope.test.ts; the function it
 * names lives in migration 0233.
 */

/** The branch a shift is attributable to, or NULL when it cannot be attributed. */
export function shiftBranchExpression(shiftAlias: string): string {
  const s = shiftAlias;
  return `coalesce(${s}.location_id, app_shift_attribution_branch(${s}.business_id, ${s}.location_id, ${s}.employee_id))`;
}

/** "This shift belongs to the branch bound to `locationParam`." */
export function shiftInBranchSql(shiftAlias: string, locationParam: string): string {
  return `${shiftBranchExpression(shiftAlias)} = ${locationParam}`;
}

/** "This shift belongs to one of the branches bound to `arrayParam` (a uuid[])." */
export function shiftInBranchesSql(shiftAlias: string, arrayParam: string): string {
  return `${shiftBranchExpression(shiftAlias)} = ANY(${arrayParam}::uuid[])`;
}

/**
 * The JavaScript twin of the predicate, for the places that already hold the
 * attributed branch (a row loaded for a force-close, say) and must answer
 * "may this caller touch it?" without another round trip.
 *
 * An unattributed shift is reachable only by a caller allowed to see every
 * branch — never by one branch's manager.
 */
export function isShiftInAllowedBranches(
  attributedLocationId: string | null,
  allowedLocationIds: readonly string[] | null,
): boolean {
  if (allowedLocationIds === null) return true;
  if (attributedLocationId === null) return false;
  return allowedLocationIds.includes(attributedLocationId);
}
