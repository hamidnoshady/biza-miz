import { query, withTenantTransaction } from "./db";
import { branchScopeSql } from "./location-access";
import type { RosterInput } from "./marketing-roster";

export async function listMarketers(businessId: string, locationIds: string[], search: string, page: number) {
  const { rows } = await query<{ id: string; name: string; kind: string; status: string; location_name: string; user_active: boolean | null }>(
    `SELECT a.id, CASE WHEN a.user_id IS NOT NULL THEN u.full_name ELSE a.display_name END AS name,
            a.kind, a.status, l.name AS location_name, (u.is_active AND (u.membership_status IS NULL OR u.membership_status = 'active')) AS user_active
       FROM marketing_agents a JOIN locations l ON l.id = a.location_id AND l.business_id = a.business_id
       LEFT JOIN users u ON u.id = a.user_id AND u.business_id = a.business_id
      WHERE a.business_id = $1 AND a.location_id = ANY($2::uuid[])
        AND (CASE WHEN a.user_id IS NOT NULL THEN u.full_name ELSE a.display_name END) ILIKE '%' || $3 || '%' ESCAPE '\\'
      ORDER BY a.created_at DESC, a.id DESC LIMIT 21 OFFSET $4`,
    [businessId, locationIds, search.replace(/[\\%_]/g, "\\$&"), (page - 1) * 20],
  );
  return { marketers: rows.slice(0, 20), hasMore: rows.length > 20 };
}

export async function listRosterCandidates(businessId: string, locationIds: string[]) {
  const [locations, users] = await Promise.all([
    query<{ id: string; name: string }>(`SELECT id, name FROM locations WHERE business_id = $1 AND id = ANY($2::uuid[]) ORDER BY name, id`, [businessId, locationIds]),
    query<{ id: string; full_name: string; location_id: string }>(
      `SELECT u.id, u.full_name, l.id AS location_id FROM users u JOIN locations l ON l.business_id = u.business_id
       WHERE u.business_id = $1 AND u.is_active AND (u.membership_status IS NULL OR u.membership_status = 'active') AND char_length(trim(u.full_name)) BETWEEN 1 AND 150 AND l.id = ANY($2::uuid[])
         AND ${branchScopeSql({ alias: "u", locationParam: "l.id" })}
         AND NOT EXISTS (SELECT 1 FROM marketing_agents a WHERE a.business_id = u.business_id AND a.user_id = u.id)
       ORDER BY u.full_name, u.id, l.id`, [businessId, locationIds]),
  ]);
  return { locations: locations.rows, users: users.rows };
}

export async function createMarketer(businessId: string, actorId: string, allowedLocations: string[], input: RosterInput) {
  if (!allowedLocations.includes(input.locationId)) return null;
  return withTenantTransaction(businessId, async () => {
    // Lock the branch/user while checking affinity and active state; never trust names from the client for staff.
    const location = await query(`SELECT id FROM locations WHERE business_id = $1 AND id = $2 AND is_active FOR SHARE`, [businessId, input.locationId]);
    if (!location.rowCount) return null;
    let name = input.name;
    if (input.userId) {
      const user = await query<{ full_name: string }>(
        `SELECT u.full_name FROM users u WHERE u.business_id = $1 AND u.id = $2 AND u.is_active AND (u.membership_status IS NULL OR u.membership_status = 'active')
           AND char_length(trim(u.full_name)) BETWEEN 1 AND 150
           AND ${branchScopeSql({ alias: "u", locationParam: "$3" })} FOR SHARE`,
        [businessId, input.userId, input.locationId]);
      if (!user.rows[0]) return null;
      name = user.rows[0].full_name;
    }
    const { rows } = await query<{ id: string }>(
      `INSERT INTO marketing_agents (business_id, location_id, user_id, display_name, kind, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [businessId, input.locationId, input.userId, name, input.kind, actorId]);
    await query(`INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
      VALUES ($1, $2, $3, 'growth.marketer_created', 'marketing_agent', $4, $5::jsonb)`,
    [businessId, input.locationId, actorId, rows[0].id, JSON.stringify({ kind: input.kind, userId: input.userId })]);
    return rows[0];
  });
}
