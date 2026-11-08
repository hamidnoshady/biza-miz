import { query, withTenantTransaction } from "./db";
import { parseTransition, type AssignmentInput, type AssignmentStatus, type TargetInput, type TargetChange, type TargetStatus } from "./marketing-operations";
import { branchScopeSql } from "./location-access";

function escaped(search: string) { return search.replace(/[\\%_]/g, "\\$&"); }
async function audit(businessId: string, locationId: string, actorId: string, action: string, entity: string, id: string, payload: object) {
  await query(`INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [businessId, locationId, actorId, action, entity, id, JSON.stringify(payload)]);
}
export async function targetLocations(businessId: string, locations: string[]) {
  return (await query<{ id: string; name: string }>(`SELECT id, name FROM locations WHERE business_id=$1 AND id=ANY($2::uuid[]) AND is_active ORDER BY name, id`, [businessId, locations])).rows;
}
export async function listTargets(businessId: string, locations: string[], search: string, page: number, status: TargetStatus = "active") {
  const { rows } = await query<{ id: string; site_label: string; city: string; neighborhood: string; location_name: string; party_linked: boolean; status: TargetStatus; revision: number }>(
    `SELECT t.id, t.site_label, t.city, t.neighborhood, l.name AS location_name, (t.party_id IS NOT NULL) AS party_linked, t.status, t.revision
       FROM marketing_targets t JOIN locations l ON l.business_id=t.business_id AND l.id=t.location_id
      WHERE t.business_id=$1 AND t.location_id=ANY($2::uuid[]) AND t.status=$5
        AND (t.site_label ILIKE '%' || $3 || '%' ESCAPE '\\' OR t.city ILIKE '%' || $3 || '%' ESCAPE '\\')
      ORDER BY t.created_at DESC, t.id DESC LIMIT 21 OFFSET $4`, [businessId, locations, escaped(search), (page-1)*20, status]);
  return { targets: rows.slice(0,20), hasMore: rows.length > 20 };
}
export async function createTarget(businessId: string, actor: string, locations: string[], input: TargetInput) {
  if (!locations.includes(input.locationId)) return null;
  return withTenantTransaction(businessId, async () => {
    const location = await query(`SELECT id FROM locations WHERE business_id=$1 AND id=$2 AND is_active FOR SHARE`, [businessId, input.locationId]);
    if (!location.rowCount) return null;
    if (input.partyId) {
      const party = await query(`SELECT id FROM parties WHERE business_id=$1 AND id=$2 AND is_active AND merged_into_id IS NULL FOR SHARE`, [businessId, input.partyId]);
      if (!party.rowCount) return null;
    }
    const { rows } = await query<{ id: string }>(`INSERT INTO marketing_targets (business_id, location_id, party_id, site_label, city, neighborhood, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [businessId,input.locationId,input.partyId,input.siteLabel,input.city,input.neighborhood,actor]);
    await audit(businessId,input.locationId,actor,"growth.marketing_target_created","marketing_target",rows[0].id,{ partyId: input.partyId });
    return rows[0];
  });
}
/** Edit a site or change its lifecycle; the CRM party and branch never change here. */
export async function changeTarget(businessId: string, actor: string, locations: string[], id: string, change: TargetChange) {
  return withTenantTransaction(businessId, async () => {
    const { rows } = await query<{ location_id: string; status: TargetStatus; revision: number; site_label: string; city: string; neighborhood: string }>(
      `SELECT t.location_id, t.status, t.revision, t.site_label, t.city, t.neighborhood FROM marketing_targets t
        JOIN locations l ON l.business_id=t.business_id AND l.id=t.location_id
        WHERE t.business_id=$1 AND t.id=$2 AND t.location_id=ANY($3::uuid[]) AND l.is_active
        FOR UPDATE OF t FOR SHARE OF l`, [businessId,id,locations]);
    const target = rows[0];
    if (!target) return "not_found" as const;
    if (target.revision !== change.expectedRevision) return "conflict" as const;
    if ((change.action === "archive" && target.status !== "active") || (change.action === "restore" && target.status !== "archived") || (change.action === "edit" && target.status !== "active")) return "conflict" as const;
    if (change.action === "archive") {
      // Creation takes FOR SHARE on this target before inserting; locking the
      // target first makes the open-work check serialize with assignment creation.
      const open = await query(`SELECT 1 FROM marketing_assignments WHERE business_id=$1 AND target_id=$2 AND status IN ('planned','in_progress') LIMIT 1`, [businessId,id]);
      if (open.rowCount) return "open_assignments" as const;
    }
    const nextStatus = change.action === "archive" ? "archived" : change.action === "restore" ? "active" : target.status;
    const siteLabel = change.action === "edit" ? change.siteLabel : target.site_label;
    const city = change.action === "edit" ? change.city : target.city;
    const neighborhood = change.action === "edit" ? change.neighborhood : target.neighborhood;
    await query(`UPDATE marketing_targets SET site_label=$3, city=$4, neighborhood=$5, status=$6, revision=revision+1, updated_at=now() WHERE business_id=$1 AND id=$2`,
      [businessId,id,siteLabel,city,neighborhood,nextStatus]);
    await audit(businessId,target.location_id,actor,"growth.marketing_target_changed","marketing_target",id,{ action: change.action, from: { status: target.status, siteLabel: target.site_label, city: target.city, neighborhood: target.neighborhood }, to: { status: nextStatus, siteLabel, city, neighborhood }, revision: target.revision+1 });
    return "updated" as const;
  });
}

export async function listAssignments(businessId: string, locations: string[], search: string, page: number) {
  const { rows } = await query<{ id: string; title: string; status: AssignmentStatus; due_date: string | null; target: string; agent: string; location_name: string }>(
    `SELECT x.id, x.title, x.status, x.due_date::text AS due_date, t.site_label AS target,
       CASE WHEN a.user_id IS NULL THEN a.display_name ELSE u.full_name END AS agent, l.name AS location_name
       FROM marketing_assignments x
       JOIN marketing_targets t ON t.id=x.target_id AND t.business_id=x.business_id AND t.location_id=x.location_id
       JOIN marketing_agents a ON a.id=x.agent_id AND a.business_id=x.business_id AND a.location_id=x.location_id
       LEFT JOIN users u ON u.id=a.user_id AND u.business_id=a.business_id
       JOIN locations l ON l.id=x.location_id AND l.business_id=x.business_id
      WHERE x.business_id=$1 AND x.location_id=ANY($2::uuid[]) AND x.title ILIKE '%' || $3 || '%' ESCAPE '\\'
      ORDER BY x.created_at DESC, x.id DESC LIMIT 21 OFFSET $4`, [businessId, locations, escaped(search), (page-1)*20]);
  return { assignments: rows.slice(0,20), hasMore: rows.length > 20 };
}
export async function assignmentOptions(businessId: string, locations: string[], branchId: string | null, targetSearch = "", targetPage = 1, agentSearch = "", agentPage = 1) {
  const selected = branchId && locations.includes(branchId) ? [branchId] : [];
  const [branches, targets, agents] = await Promise.all([
    targetLocations(businessId, locations),
    query<{ id: string; location_id: string; site_label: string }>(`SELECT id, location_id, site_label FROM marketing_targets WHERE business_id=$1 AND location_id=ANY($2::uuid[]) AND status='active' AND site_label ILIKE '%' || $3 || '%' ESCAPE '\\' ORDER BY site_label, id LIMIT 21 OFFSET $4`,[businessId,selected,escaped(targetSearch),(targetPage-1)*20]),
    query<{ id: string; location_id: string; name: string }>(`SELECT a.id, a.location_id, CASE WHEN a.user_id IS NULL THEN a.display_name ELSE u.full_name END AS name FROM marketing_agents a LEFT JOIN users u ON u.id=a.user_id AND u.business_id=a.business_id WHERE a.business_id=$1 AND a.location_id=ANY($2::uuid[]) AND a.status='active' AND (a.user_id IS NULL OR (u.is_active AND (u.membership_status IS NULL OR u.membership_status='active') AND ${branchScopeSql({ alias: "u", locationParam: "a.location_id" })})) AND (CASE WHEN a.user_id IS NULL THEN a.display_name ELSE u.full_name END) ILIKE '%' || $3 || '%' ESCAPE '\\' ORDER BY name, a.id LIMIT 21 OFFSET $4`,[businessId,selected,escaped(agentSearch),(agentPage-1)*20]),
  ]);
  return { locations: branches, targets: targets.rows.slice(0,20), targetHasMore: targets.rows.length > 20, agents: agents.rows.slice(0,20), agentHasMore: agents.rows.length > 20 };
}
export async function createAssignment(businessId: string, actor: string, locations: string[], input: AssignmentInput) {
  if (!locations.includes(input.locationId)) return null;
  return withTenantTransaction(businessId, async () => {
    const location = await query(`SELECT id FROM locations WHERE business_id=$1 AND id=$2 AND is_active FOR SHARE`, [businessId,input.locationId]);
    if (!location.rowCount) return null;
    const target = await query(`SELECT id FROM marketing_targets WHERE business_id=$1 AND location_id=$2 AND id=$3 AND status='active' FOR SHARE`, [businessId,input.locationId,input.targetId]);
    const agent = await query<{ user_id: string | null }>(`SELECT a.user_id FROM marketing_agents a WHERE a.business_id=$1 AND a.location_id=$2 AND a.id=$3 AND a.status='active' FOR SHARE`, [businessId,input.locationId,input.agentId]);
    if (!target.rowCount || !agent.rows[0]) return null;
    if (agent.rows[0].user_id) {
      const user = await query(`SELECT u.id FROM users u WHERE u.business_id=$1 AND u.id=$2 AND u.is_active AND (u.membership_status IS NULL OR u.membership_status='active') AND ${branchScopeSql({ alias: "u", locationParam: "$3" })} FOR SHARE`, [businessId,agent.rows[0].user_id,input.locationId]);
      if (!user.rowCount) return null;
    }
    const { rows } = await query<{ id: string }>(`INSERT INTO marketing_assignments (business_id,location_id,target_id,agent_id,title,due_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[businessId,input.locationId,input.targetId,input.agentId,input.title,input.dueDate,actor]);
    await audit(businessId,input.locationId,actor,"growth.marketing_assignment_created","marketing_assignment",rows[0].id,{ targetId: input.targetId, agentId: input.agentId });
    return rows[0];
  });
}
export async function transitionAssignment(businessId: string, actor: string, locations: string[], id: string, expected: AssignmentStatus, next: AssignmentStatus) {
  if (!parseTransition({ expected, next })) return "invalid" as const;
  return withTenantTransaction(businessId, async () => {
    const { rows } = await query<{ location_id: string; status: AssignmentStatus }>(`SELECT location_id, status FROM marketing_assignments WHERE business_id=$1 AND id=$2 AND location_id=ANY($3::uuid[]) FOR UPDATE`,[businessId,id,locations]);
    if (!rows[0]) return "not_found" as const;
    if (rows[0].status !== expected) return "conflict" as const;
    await query(`UPDATE marketing_assignments SET status=$3, updated_at=now() WHERE business_id=$1 AND id=$2`,[businessId,id,next]);
    await audit(businessId,rows[0].location_id,actor,"growth.marketing_assignment_status_changed","marketing_assignment",id,{ from: expected, to: next });
    return "updated" as const;
  });
}

/** Own work only: identity is resolved by the authenticated membership, not the request. */
export async function listOwnAssignments(businessId: string, actor: string, locations: string[], search: string, page: number) {
  const { rows } = await query<{ id: string; title: string; status: AssignmentStatus; due_date: string | null; target: string; location_name: string }>(
    `SELECT x.id, x.title, x.status, x.due_date::text AS due_date, t.site_label AS target, l.name AS location_name
       FROM marketing_assignments x
       JOIN marketing_agents a ON a.business_id=x.business_id AND a.location_id=x.location_id AND a.id=x.agent_id
       JOIN users u ON u.business_id=a.business_id AND u.id=a.user_id
       JOIN marketing_targets t ON t.business_id=x.business_id AND t.location_id=x.location_id AND t.id=x.target_id
       JOIN locations l ON l.business_id=x.business_id AND l.id=x.location_id
      WHERE x.business_id=$1 AND x.location_id=ANY($2::uuid[]) AND u.id=$3
        AND a.status='active' AND u.is_active AND (u.membership_status IS NULL OR u.membership_status='active')
        AND l.is_active AND ${branchScopeSql({ alias: "u", locationParam: "x.location_id" })}
        AND x.title ILIKE '%' || $4 || '%' ESCAPE '\\'
      ORDER BY x.created_at DESC, x.id DESC LIMIT 21 OFFSET $5`,
    [businessId, locations, actor, escaped(search), (page-1)*20]);
  return { assignments: rows.slice(0,20), hasMore: rows.length > 20 };
}

/** An employee may start/complete their own work; cancellation stays manager-owned. */
export async function transitionOwnAssignment(businessId: string, actor: string, locations: string[], id: string, expected: AssignmentStatus, next: AssignmentStatus) {
  if (!parseTransition({ expected, next }) || next === "canceled") return "invalid" as const;
  return withTenantTransaction(businessId, async () => {
    const { rows } = await query<{ location_id: string; status: AssignmentStatus }>(
      `SELECT x.location_id, x.status FROM marketing_assignments x
       JOIN marketing_agents a ON a.business_id=x.business_id AND a.location_id=x.location_id AND a.id=x.agent_id
       JOIN users u ON u.business_id=a.business_id AND u.id=a.user_id
       JOIN locations l ON l.business_id=x.business_id AND l.id=x.location_id
       WHERE x.business_id=$1 AND x.id=$2 AND x.location_id=ANY($3::uuid[]) AND u.id=$4
         AND a.status='active' AND u.is_active AND (u.membership_status IS NULL OR u.membership_status='active')
         AND l.is_active AND ${branchScopeSql({ alias: "u", locationParam: "x.location_id" })}
       FOR UPDATE OF x FOR SHARE OF a, u, l`, [businessId,id,locations,actor]);
    if (!rows[0]) return "not_found" as const;
    if (rows[0].status !== expected) return "conflict" as const;
    await query(`UPDATE marketing_assignments SET status=$3, updated_at=now() WHERE business_id=$1 AND id=$2`, [businessId,id,next]);
    await audit(businessId,rows[0].location_id,actor,"growth.marketing_assignment_status_changed","marketing_assignment",id,{ from: expected, to: next });
    return "updated" as const;
  });
}
