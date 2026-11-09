import { query, withTenantTransaction } from "./db";
import type { TouchInput, TouchChannel } from "./marketing-touchpoints";
import type { CrmSource } from "./crm-sources";
import { branchScopeSql } from "./location-access";

type SavedTouch = { id: string; location_id: string; assignment_id: string; lead_id: string; channel: TouchChannel; source: CrmSource; created_by: string | null };
export type SaveTouchResult = { kind: "created" | "replayed"; id: string } | { kind: "not_found" } | { kind: "conflict" } | { kind: "party_mismatch" };
function matches(row: SavedTouch, actor: string, locations: string[], input: TouchInput) {
  return locations.includes(row.location_id) && row.created_by === actor && row.assignment_id === input.assignmentId && row.lead_id === input.leadId && row.channel === input.channel && row.source === input.source;
}
const FIND_EXISTING = `SELECT id, location_id, assignment_id, lead_id, channel, source, created_by FROM marketing_touchpoints WHERE business_id=$1 AND idempotency_key=$2`;

export async function listMarketingTouches(businessId: string, locations: string[], search: string, page: number, canSeeLead: boolean) {
  const term = search.replace(/[\\%_]/g, "\\$&");
  const { rows } = await query<{ id: string; title: string; target: string; agent: string; location_name: string; location_timezone: string; channel: TouchChannel; source: CrmSource; recorded_at: string; lead_id: string | null; lead_name: string | null }>(
    `SELECT m.id, x.title, t.site_label AS target, CASE WHEN a.user_id IS NULL THEN a.display_name ELSE u.full_name END AS agent,
       l.name AS location_name, l.timezone AS location_timezone, m.channel, m.source, m.recorded_at::text AS recorded_at,
       CASE WHEN $5::boolean THEN cl.id ELSE NULL END AS lead_id,
       CASE WHEN $5::boolean THEN cl.name ELSE NULL END AS lead_name
       FROM marketing_touchpoints m
       JOIN marketing_assignments x ON x.business_id=m.business_id AND x.location_id=m.location_id AND x.id=m.assignment_id
       JOIN marketing_targets t ON t.business_id=x.business_id AND t.location_id=x.location_id AND t.id=x.target_id
       JOIN marketing_agents a ON a.business_id=x.business_id AND a.location_id=x.location_id AND a.id=x.agent_id
       LEFT JOIN users u ON u.business_id=a.business_id AND u.id=a.user_id
       JOIN locations l ON l.business_id=m.business_id AND l.id=m.location_id
       JOIN crm_leads cl ON cl.business_id=m.business_id AND cl.id=m.lead_id
      WHERE m.business_id=$1 AND m.location_id=ANY($2::uuid[]) AND x.title ILIKE '%' || $3 || '%' ESCAPE '\\'
      ORDER BY m.recorded_at DESC, m.id DESC LIMIT 21 OFFSET $4`,
    [businessId, locations, term, (page-1)*20, canSeeLead]);
  return { touches: rows.slice(0, 20), hasMore: rows.length > 20 };
}

export async function touchOptions(businessId: string, locations: string[], search: string, page: number) {
  const term = search.replace(/[\\%_]/g, "\\$&");
  const { rows } = await query<{ id: string; title: string; target: string; location_name: string }>(
    `SELECT x.id, x.title, t.site_label AS target, l.name AS location_name FROM marketing_assignments x
       JOIN marketing_targets t ON t.business_id=x.business_id AND t.location_id=x.location_id AND t.id=x.target_id
       JOIN locations l ON l.business_id=x.business_id AND l.id=x.location_id
      WHERE x.business_id=$1 AND x.location_id=ANY($2::uuid[]) AND x.status <> 'canceled'
        AND x.title ILIKE '%' || $3 || '%' ESCAPE '\\'
      ORDER BY x.created_at DESC, x.id DESC LIMIT 21 OFFSET $4`, [businessId, locations, term, (page-1)*20]);
  return { assignments: rows.slice(0,20), hasMore: rows.length > 20 };
}

/** One request key makes retries safe, including an ambiguous network failure. */
export async function recordMarketingTouch(businessId: string, actor: string, locations: string[], input: TouchInput): Promise<SaveTouchResult> {
  return withTenantTransaction(businessId, async () => {
    const existing = await query<SavedTouch>(FIND_EXISTING, [businessId, input.idempotencyKey]);
    if (existing.rows[0]) return matches(existing.rows[0], actor, locations, input) ? { kind: "replayed", id: existing.rows[0].id } : { kind: "conflict" };
    const assignment = await query<{ location_id: string; party_id: string | null }>(
      `SELECT x.location_id, t.party_id FROM marketing_assignments x JOIN marketing_targets t ON t.business_id=x.business_id AND t.location_id=x.location_id AND t.id=x.target_id
       JOIN locations l ON l.business_id=x.business_id AND l.id=x.location_id
       WHERE x.business_id=$1 AND x.id=$2 AND x.location_id=ANY($3::uuid[]) AND x.status <> 'canceled' AND t.status='active' AND l.is_active FOR SHARE OF x, t, l`,
      [businessId, input.assignmentId, locations]);
    if (!assignment.rows[0]) return { kind: "not_found" };
    const lead = await query<{ converted_party_id: string | null }>(`SELECT converted_party_id FROM crm_leads WHERE business_id=$1 AND id=$2 FOR SHARE`, [businessId, input.leadId]);
    if (!lead.rows[0]) return { kind: "not_found" };
    if (assignment.rows[0].party_id && lead.rows[0].converted_party_id && assignment.rows[0].party_id !== lead.rows[0].converted_party_id) return { kind: "party_mismatch" };
    const inserted = await query<{ id: string }>(
      `INSERT INTO marketing_touchpoints (business_id, location_id, assignment_id, lead_id, channel, source, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (business_id,idempotency_key) DO NOTHING RETURNING id`,
      [businessId, assignment.rows[0].location_id, input.assignmentId, input.leadId, input.channel, input.source, input.idempotencyKey, actor]);
    if (!inserted.rows[0]) {
      const raced = await query<SavedTouch>(FIND_EXISTING, [businessId, input.idempotencyKey]);
      return raced.rows[0] && matches(raced.rows[0], actor, locations, input) ? { kind: "replayed", id: raced.rows[0].id } : { kind: "conflict" };
    }
    await query(`INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload) VALUES ($1,$2,$3,'growth.marketing_touch_recorded','marketing_touchpoint',$4,$5::jsonb)`,
      [businessId, assignment.rows[0].location_id, actor, inserted.rows[0].id, JSON.stringify({ assignmentId: input.assignmentId, leadId: input.leadId, channel: input.channel, source: input.source })]);
    return { kind: "created", id: inserted.rows[0].id };
  });
}

/** Read-only projection of Growth source facts for one CRM lead, never a copy. */
export async function listMarketingTouchesForLead(businessId: string, locations: string[], leadId: string, page: number) {
  const { rows } = await query<{
    id: string; title: string; target: string; agent: string; location_name: string; location_timezone: string;
    channel: TouchChannel; source: CrmSource; recorded_at: string;
  }>(
    `SELECT m.id, x.title, t.site_label AS target,
            CASE WHEN a.user_id IS NULL THEN a.display_name ELSE u.full_name END AS agent,
            l.name AS location_name, l.timezone AS location_timezone, m.channel, m.source, m.recorded_at::text AS recorded_at
       FROM marketing_touchpoints m
       JOIN marketing_assignments x ON x.business_id=m.business_id AND x.location_id=m.location_id AND x.id=m.assignment_id
       JOIN marketing_targets t ON t.business_id=x.business_id AND t.location_id=x.location_id AND t.id=x.target_id
       JOIN marketing_agents a ON a.business_id=x.business_id AND a.location_id=x.location_id AND a.id=x.agent_id
       LEFT JOIN users u ON u.business_id=a.business_id AND u.id=a.user_id
       JOIN locations l ON l.business_id=m.business_id AND l.id=m.location_id
      WHERE m.business_id=$1 AND m.lead_id=$2 AND m.location_id=ANY($3::uuid[]) AND l.is_active
      ORDER BY m.recorded_at DESC, m.id DESC LIMIT 21 OFFSET $4`,
    [businessId, leadId, locations, (page-1)*20]);
  return { touches: rows.slice(0,20), hasMore: rows.length > 20 };
}

/** Staff may report only against their own currently authorized employee assignment. */
export async function recordOwnMarketingTouch(businessId: string, actor: string, locations: string[], input: TouchInput): Promise<SaveTouchResult> {
  return withTenantTransaction(businessId, async () => {
    // Lock identity/scope even on a retry; a revoked or inactive member cannot
    // replay an old key. The nested writer joins this same transaction.
    const own = await query<{ location_id: string }>(`SELECT x.location_id FROM marketing_assignments x
      JOIN marketing_agents a ON a.business_id=x.business_id AND a.location_id=x.location_id AND a.id=x.agent_id
      JOIN users u ON u.business_id=a.business_id AND u.id=a.user_id
      JOIN locations l ON l.business_id=x.business_id AND l.id=x.location_id
      WHERE x.business_id=$1 AND x.id=$2 AND x.location_id=ANY($3::uuid[]) AND u.id=$4
        AND a.status='active' AND u.is_active AND (u.membership_status IS NULL OR u.membership_status='active')
        AND l.is_active
      FOR SHARE OF x, a, u, l`, [businessId,input.assignmentId,locations,actor]);
    if (!own.rows[0]) return { kind: "not_found" };
    // A concurrent membership edit can change user_locations while this query
    // waits on the user lock. Check again in a fresh READ COMMITTED snapshot
    // after acquiring that lock, as membership writers update users first.
    const scope = await query(`SELECT u.id FROM users u WHERE u.business_id=$1 AND u.id=$2
      AND ${branchScopeSql({ alias: "u", locationParam: "$3" })}`, [businessId,actor,own.rows[0].location_id]);
    if (!scope.rowCount) return { kind: "not_found" };
    return recordMarketingTouch(businessId,actor,locations,input);
  });
}

/** Reports created by this employee for their own currently authorized assignments. */
export async function listOwnMarketingTouches(businessId: string, actor: string, locations: string[], search: string, page: number) {
  const term = search.replace(/[\\%_]/g, "\\$&");
  const { rows } = await query<{
    id: string; title: string; target: string; lead_name: string; location_name: string; location_timezone: string;
    channel: TouchChannel; source: CrmSource; recorded_at: string;
  }>(`SELECT m.id, x.title, t.site_label AS target, cl.name AS lead_name,
            l.name AS location_name, l.timezone AS location_timezone, m.channel, m.source, m.recorded_at::text AS recorded_at
       FROM marketing_touchpoints m
       JOIN marketing_assignments x ON x.business_id=m.business_id AND x.location_id=m.location_id AND x.id=m.assignment_id
       JOIN marketing_targets t ON t.business_id=x.business_id AND t.location_id=x.location_id AND t.id=x.target_id
       JOIN marketing_agents a ON a.business_id=x.business_id AND a.location_id=x.location_id AND a.id=x.agent_id
       JOIN users u ON u.business_id=a.business_id AND u.id=a.user_id
       JOIN locations l ON l.business_id=m.business_id AND l.id=m.location_id
       JOIN crm_leads cl ON cl.business_id=m.business_id AND cl.id=m.lead_id
      WHERE m.business_id=$1 AND m.created_by=$2 AND u.id=$2 AND m.location_id=ANY($3::uuid[])
        AND a.status='active' AND u.is_active AND (u.membership_status IS NULL OR u.membership_status='active')
        AND l.is_active AND ${branchScopeSql({ alias: "u", locationParam: "x.location_id" })}
        AND (x.title ILIKE '%' || $4 || '%' ESCAPE '\\' OR cl.name ILIKE '%' || $4 || '%' ESCAPE '\\')
      ORDER BY m.recorded_at DESC, m.id DESC LIMIT 21 OFFSET $5`,
    [businessId,actor,locations,term,(page-1)*20]);
  return { touches: rows.slice(0,20), hasMore: rows.length > 20 };
}
