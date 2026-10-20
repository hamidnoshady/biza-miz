import type { PoolClient } from "pg";
import type { SessionPayload } from "./auth";
import { authorize } from "./authorize";
import { query } from "./db";
import { branchScopeSql } from "./location-access";
import { PERMISSIONS } from "./permissions";
import {
  ASSIGNABLE_FLOOR_STAFF_ROLES,
  isEligibleStaffAtLocation,
  listEligibleStaffAtLocation,
  type EligibleStaffMember,
} from "./staff-eligibility";

export interface EligibleStaffRow {
  id: string;
  full_name: string;
  role?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

async function resolvePermissions(session: SessionPayload): Promise<ReadonlySet<string>> {
  try {
    const decision = await authorize(session);
    return decision.ok ? decision.membership.permissions : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

export async function resolveFloorSnapshotCapabilities(
  session: SessionPayload,
): Promise<{ canSeeOrders: boolean; canEditTables: boolean }> {
  const perms = await resolvePermissions(session);
  return {
    canSeeOrders: perms.has(PERMISSIONS.ordersView) || perms.has(PERMISSIONS.ordersCreate),
    canEditTables: perms.has(PERMISSIONS.tablesEdit),
  };
}

export async function canViewSessionCustomerPhone(session: SessionPayload): Promise<boolean> {
  const perms = await resolvePermissions(session);
  return (
    perms.has(PERMISSIONS.partiesView) ||
    perms.has(PERMISSIONS.partiesManage) ||
    perms.has(PERMISSIONS.reservationsManage)
  );
}

export async function listAssignableFloorStaff(
  businessId: string,
  locationId: string,
): Promise<EligibleStaffRow[]> {
  const baseMembers: EligibleStaffMember[] = await listEligibleStaffAtLocation(
    businessId,
    locationId,
    ASSIGNABLE_FLOOR_STAFF_ROLES,
  );
  const result: EligibleStaffRow[] = baseMembers.map((m) => ({
    id: m.id,
    full_name: m.fullName,
  }));
  const seen = new Set(result.map((r) => r.id));

  const customCandidates = await query<{
    id: string;
    full_name: string;
    role: string;
    custom_role_id: string | null;
  }>(
    `SELECT u.id, u.full_name, u.role::text AS role, u.custom_role_id::text AS custom_role_id
       FROM users u
      WHERE u.business_id = $1
        AND u.is_active = TRUE
        AND COALESCE(u.membership_status, 'active') = 'active'
        AND ${branchScopeSql({ alias: "u", locationParam: "$2" })}
      ORDER BY u.full_name, u.id`,
    [businessId, locationId],
  );

  for (const candidate of customCandidates.rows) {
    if (seen.has(candidate.id)) continue;
    const perms = await resolvePermissions({
      sub: candidate.id,
      fullName: candidate.full_name,
      businessId,
      role: candidate.role as SessionPayload["role"],
      locationId,
      tokenVersion: 0,
    });
    if (perms.has(PERMISSIONS.tablesManage) || perms.has(PERMISSIONS.ordersCreate)) {
      seen.add(candidate.id);
      result.push({
        id: candidate.id,
        full_name: candidate.full_name,
        role: candidate.role,
      });
    }
  }
  return result;
}

export async function validWaiterId(
  businessId: string,
  locationId: string,
  waiterId: string | null | undefined | unknown,
): Promise<string | null | false> {
  if (!waiterId) return null;
  if (typeof waiterId !== "string") return false;
  const id = waiterId.trim();
  if (!id) return null;
  if (!isUuid(id)) return false;

  const eligibleBuiltIn = await isEligibleStaffAtLocation(
    businessId,
    locationId,
    id,
    ASSIGNABLE_FLOOR_STAFF_ROLES,
  );
  if (eligibleBuiltIn) return id;

  const { rows } = await query<{ id: string; full_name: string; role: string }>(
    `SELECT u.id, u.full_name, u.role::text AS role
       FROM users u
      WHERE u.id = $3
        AND u.business_id = $1
        AND u.is_active = TRUE
        AND COALESCE(u.membership_status, 'active') = 'active'
        AND ${branchScopeSql({ alias: "u", locationParam: "$2" })}
      LIMIT 1`,
    [businessId, locationId, id],
  );
  if (!rows[0]) return false;
  const perms = await resolvePermissions({
    sub: rows[0].id,
    fullName: rows[0].full_name,
    businessId,
    role: rows[0].role as SessionPayload["role"],
    locationId,
    tokenVersion: 0,
  });
  return perms.has(PERMISSIONS.tablesManage) || perms.has(PERMISSIONS.ordersCreate) ? id : false;
}

export async function resolveSectionId(
  locationId: string,
  sectionId: string | null | undefined | unknown,
): Promise<string | null | false> {
  if (!sectionId) return null;
  if (typeof sectionId !== "string") return false;
  const id = sectionId.trim();
  if (!id) return null;
  if (!isUuid(id)) return false;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM floor_sections WHERE id = $1 AND location_id = $2`,
    [id, locationId],
  );
  return rows.length > 0 ? rows[0].id : false;
}

export interface FloorSectionAccessScope {
  mode: "all" | "assigned_sections";
  hasFullFloorAccess: boolean;
  assignedSectionIds: string[];
  permissions: ReadonlySet<string>;
}

export async function resolveFloorSectionAccessScope(
  session: SessionPayload,
  locationId: string,
): Promise<FloorSectionAccessScope> {
  const permissions = await resolvePermissions(session);
  const { rows: assignedRows } = await query<{ id: string }>(
    `SELECT id FROM floor_sections WHERE location_id = $1 AND assigned_waiter_id = $2 ORDER BY sort_order, name`,
    [locationId, session.sub],
  );
  const assignedSectionIds = (assignedRows ?? []).map((r) => r.id);
  const isPrivilegedRole = permissions.has(PERMISSIONS.tablesEdit);
  const hasFullFloorAccess =
    permissions.size > 0 && (isPrivilegedRole || assignedSectionIds.length === 0);
  return {
    mode: hasFullFloorAccess ? "all" : "assigned_sections",
    hasFullFloorAccess,
    assignedSectionIds,
    permissions,
  };
}

export async function checkTableSectionAuthorization(
  session: SessionPayload,
  locationId: string,
  tableIds: readonly string[],
): Promise<{ allowed: boolean; scope: FloorSectionAccessScope }> {
  const scope = await resolveFloorSectionAccessScope(session, locationId);
  if (scope.hasFullFloorAccess || tableIds.length === 0) {
    return { allowed: true, scope };
  }
  const validIds = tableIds.filter(isUuid);
  if (validIds.length === 0) {
    return { allowed: true, scope };
  }
  const { rows } = await query<{
    table_id: string;
    section_id: string | null;
    assigned_waiter_id: string | null;
  }>(
    `SELECT dt.id AS table_id, dt.section_id, fs.assigned_waiter_id
       FROM dining_tables dt
       LEFT JOIN floor_sections fs ON fs.id = dt.section_id AND fs.location_id = dt.location_id
      WHERE dt.location_id = $1 AND dt.id = ANY($2::uuid[])`,
    [locationId, validIds],
  );
  for (const row of rows) {
    if (row.assigned_waiter_id && row.assigned_waiter_id !== session.sub) {
      return { allowed: false, scope };
    }
  }
  return { allowed: true, scope };
}

export async function recordFloorAudit(
  input: {
    businessId: string;
    locationId: string;
    userId: string | null;
    action:
      | "table.created"
      | "table.updated"
      | "table.status_changed"
      | "table.archived"
      | "table.restored"
      | "floor_section.created"
      | "floor_section.updated"
      | "floor_section.deleted";
    entity: "dining_table" | "floor_section";
    entityId: string;
    payload: Record<string, unknown>;
  },
  client?: PoolClient,
): Promise<void> {
  const sql = `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`;
  const params = [
    input.businessId,
    input.locationId,
    input.userId,
    input.action,
    input.entity,
    input.entityId,
    JSON.stringify(input.payload),
  ];
  if (client) {
    await client.query(sql, params);
  } else {
    await query(sql, params);
  }
}
