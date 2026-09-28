import type { PoolClient } from "pg";
import { query, withTenant } from "../db";
import { parseOverrides } from "../permissions";
import type { Role } from "../auth-edge";
import type { LocationScope } from "../location-access";
import { iamEntityTypeFor } from "./events";
import { iamStateHash } from "./reconciliation";
import { IAM_SCHEMA_VERSION, IAM_SNAPSHOT_SCHEMA_VERSION, type IamEvent, type IamEventType, type IamMembership, type IamSnapshot, type IamTenantRole } from "./model";

interface Executor { query: PoolClient["query"] }

/** Must run in the same transaction as the canonical security mutation. */
export async function appendIamEvent(client: Executor, input: {
  businessId: string; type: IamEventType; entityId: string; payload: Record<string, unknown>;
  actorUserId?: string | null; origin: IamEvent["origin"];
}): Promise<number> {
  const sequence = await client.query<{ last_sequence: string }>(
    `INSERT INTO iam_business_sequences (business_id,last_sequence) VALUES ($1,1)
     ON CONFLICT (business_id) DO UPDATE SET last_sequence=iam_business_sequences.last_sequence+1
     RETURNING last_sequence`, [input.businessId]);
  const next = Number(sequence.rows[0].last_sequence);
  await client.query(
    `INSERT INTO iam_events (business_id,sequence,event_type,entity_type,entity_id,schema_version,payload,actor_user_id,origin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.businessId, next, input.type, iamEntityTypeFor(input.type), input.entityId, IAM_SCHEMA_VERSION,
      JSON.stringify(input.payload), input.actorUserId ?? null, input.origin]);
  return next;
}

export async function listIamEvents(businessId: string, after: number, limit = 100): Promise<IamEvent[]> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const { rows } = await withTenant(businessId, () => query<{
    id: string; business_id: string; sequence: string; event_type: IamEventType; entity_type: IamEvent["entityType"];
    entity_id: string; schema_version: number; payload: Record<string, unknown>; actor_user_id: string | null;
    origin: IamEvent["origin"]; created_at: Date;
  }>(`SELECT * FROM iam_events WHERE business_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`, [businessId, after, safeLimit]));
  return rows.map((row) => ({ id: row.id, businessId: row.business_id, sequence: Number(row.sequence), eventType: row.event_type,
    entityType: row.entity_type, entityId: row.entity_id, schemaVersion: row.schema_version, payload: row.payload,
    actorUserId: row.actor_user_id, origin: row.origin, createdAt: row.created_at.toISOString() }));
}

export async function buildIamSnapshot(businessId: string, siteDeviceId: string): Promise<IamSnapshot> {
  return withTenant(businessId, async () => {
    const [members, assignments, roles, credentials, sequence] = await Promise.all([
      query<{ id:string; business_id:string; platform_user_id:string|null; role:Role; custom_role_id:string|null; full_name:string;
        email:string|null; is_active:boolean; membership_status:IamMembership["status"]; permissions:unknown;
        location_scope:LocationScope; location_id:string|null; membership_revision:string }>(
        `SELECT id,business_id,platform_user_id,role,custom_role_id,full_name,email,is_active,membership_status,
                permissions,location_scope,location_id,membership_revision FROM users WHERE business_id=$1 ORDER BY id`, [businessId]),
      query<{user_id:string;location_id:string}>(`SELECT ul.user_id,ul.location_id FROM user_locations ul JOIN users u ON u.id=ul.user_id WHERE u.business_id=$1 ORDER BY ul.user_id,ul.location_id`, [businessId]),
      query<{id:string;business_id:string;name:string;description:string;permissions:string[];default_location_scope:LocationScope;is_active:boolean;role_revision:string}>(
        `SELECT id,business_id,name,description,ARRAY(SELECT jsonb_array_elements_text(permissions)) permissions,
                default_location_scope,is_active,role_revision FROM tenant_roles WHERE business_id=$1 ORDER BY id`, [businessId]),
      query<{id:string;employee_id:string;credential_type:string;status:string}>(
        `SELECT id,employee_id,credential_type::text,status FROM employee_credentials WHERE business_id=$1 ORDER BY id`, [businessId]),
      query<{last_sequence:string}>(`SELECT last_sequence FROM iam_business_sequences WHERE business_id=$1`, [businessId]),
    ]);
    const locationMap = new Map<string,string[]>();
    for (const row of assignments.rows) locationMap.set(row.user_id, [...(locationMap.get(row.user_id) ?? []), row.location_id]);
    const memberships: IamMembership[] = members.rows.map((row) => ({ id:row.id,businessId:row.business_id,
      cloudIdentityRef:row.platform_user_id,role:row.role,customRoleId:row.custom_role_id,fullName:row.full_name,email:row.email,
      isActive:row.is_active,status:row.membership_status,overrides:parseOverrides(row.permissions),locationScope:row.location_scope,
      defaultLocationId:row.location_id,locationIds:locationMap.get(row.id) ?? [],revision:Number(row.membership_revision) }));
    const tenantRoles: IamTenantRole[] = roles.rows.map((row) => ({id:row.id,businessId:row.business_id,name:row.name,
      description:row.description,permissions:row.permissions,defaultLocationScope:row.default_location_scope,isActive:row.is_active,
      revision:Number(row.role_revision)}));
    const lastSequence = Number(sequence.rows[0]?.last_sequence ?? 0);
    return { schemaVersion:IAM_SNAPSHOT_SCHEMA_VERSION,businessId,siteDeviceId,snapshotVersion:lastSequence,lastSequence,
      stateHash:iamStateHash(memberships,tenantRoles),memberships,tenantRoles,
      credentials:credentials.rows.map((row)=>({id:row.id,userId:row.employee_id,type:row.credential_type,status:row.status,revision:1})) };
  });
}
