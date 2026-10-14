/**
 * Ownership and assignment: stable member ids, never a typed name.
 *
 * ## Why the CRM stores an id *and* a name
 *
 * `crm_deals.owner_user_id`, `crm_leads.owner_user_id`,
 * `crm_activities.assignee_user_id`, `crm_cases.assignee_user_id` and
 * `parties.crm_owner_user_id` are the truth about who owns a relationship. The
 * text columns beside them (`owner_user`, `owner_name`, `assigned_to`) are
 * **display snapshots**: they are what the row said at the time, which is what
 * an audit trail needs, and what every pre-0157 screen still renders.
 *
 * A name is not an identity: two members can share one, a member's display name
 * changes, and a former member's row must still say who had it. So writes go
 * through `resolveOwner` — an id when there is one, a name otherwise — and the
 * snapshot is written either way, because losing it would erase history rather
 * than tidy it.
 *
 * ## What `resolveOwner` refuses to do
 *
 * It will not guess. A legacy name matching two members resolves to `null`
 * (unassigned), not to whichever row the database happened to return first —
 * that is the misattribution bug the whole CRM is written to avoid, and the
 * queue for unassigned work is where such a row belongs until a human decides.
 */

import { query } from "./db";
import { isUuid } from "./uuid";

export interface AssignableMember extends Record<string, unknown> {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
}

/**
 * The members a CRM row may be assigned to.
 *
 * Deliberately minimal: id, name, role and whether they are still active — no
 * email, no permissions, no last-seen. An assignee picker needs to name a
 * colleague, and a picker that returned more would be a second, weaker copy of
 * the team screen's data reachable by a different permission.
 *
 * Inactive members are returned rather than filtered out, because reassignment
 * starts by seeing who holds what: the picker greys them, the row keeps its
 * owner until somebody moves it, and nothing is silently reassigned.
 */
export async function listAssignableMembers(businessId: string): Promise<AssignableMember[]> {
  const { rows } = await query<{ id: string; name: string; role: string; is_active: boolean }>(
    `SELECT id, coalesce(nullif(btrim(full_name), ''), email) AS name, role, is_active
       FROM users
      WHERE business_id = $1
      ORDER BY is_active DESC, name`,
    [businessId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    isActive: row.is_active,
  }));
}

export interface ResolvedOwner {
  /** The member the row is assigned to, or null when it cannot be determined. */
  userId: string | null;
  /** What to keep in the text snapshot — the typed value, resolved name, or "". */
  name: string;
}

/**
 * Turn whatever a caller supplied into a member id plus a display name.
 *
 * Accepts a uuid (verified to belong to this business — a foreign id is not an
 * assignment, it is a leak), a member's name (unambiguous matches only), or
 * nothing. Anything else leaves the row unassigned rather than inventing an
 * owner.
 */
export async function resolveOwner(
  businessId: string,
  value: string | null | undefined,
): Promise<ResolvedOwner> {
  const raw = (value ?? "").trim();
  if (!raw) return { userId: null, name: "" };

  if (isUuid(raw)) {
    const { rows } = await query<{ name: string }>(
      `SELECT coalesce(nullif(btrim(full_name), ''), email) AS name
         FROM users WHERE business_id = $1 AND id = $2`,
      [businessId, raw],
    );
    if (rows[0]) return { userId: raw, name: rows[0].name };
    return { userId: null, name: "" };
  }

  const { rows } = await query<{ id: string; name: string; matches: string }>(
    `SELECT min(id::text)::uuid AS id,
            min(coalesce(nullif(btrim(full_name), ''), email)) AS name,
            count(*)::text AS matches
       FROM users
      WHERE business_id = $1 AND btrim(lower(coalesce(full_name, ''))) = btrim(lower($2))
      HAVING btrim(coalesce($2, '')) <> ''`,
    [businessId, raw],
  );
  // Zero matches or more than one: keep the typed name as the snapshot (the row
  // still says who was meant) and leave the id empty. The unassigned queue is
  // where a human resolves it.
  if (!rows[0] || Number(rows[0].matches) !== 1) return { userId: null, name: raw };
  return { userId: rows[0].id, name: rows[0].name };
}

/**
 * The ids owned by members who can no longer sign in, for a reassignment list.
 *
 * A deactivated member's rows are not moved automatically: reassignment is a
 * decision about real customers, and doing it silently on a role change would
 * hand somebody a portfolio they never agreed to take.
 */
export async function inactiveOwners(businessId: string): Promise<{ id: string; name: string }[]> {
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT u.id, coalesce(nullif(btrim(u.full_name), ''), u.email) AS name
       FROM users u
      WHERE u.business_id = $1 AND u.is_active = false
      ORDER BY name`,
    [businessId],
  );
  return rows;
}
