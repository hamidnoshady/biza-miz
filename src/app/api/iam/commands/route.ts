import { NextRequest, NextResponse } from "next/server";
import { getPool, query, withTenant } from "@/lib/db";
import { authenticateIamSite } from "@/lib/iam/site-auth";
import { appendIamEvent } from "@/lib/iam/service";
import { effectivePermissions, parseOverrides, PERMISSIONS, type Permission, type PermissionOverrides } from "@/lib/permissions";
import { ASSIGNABLE_ROLES } from "@/lib/roles";
import type { Role } from "@/lib/auth-edge";
import { accessibleLocationIds, isLocationScope, type LocationScope } from "@/lib/location-access";
import type { IamEventType } from "@/lib/iam/model";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Changes = { permissions?: PermissionOverrides; role?: Role; customRoleId?: string | null; locationIds?: string[]; defaultLocationId?: string | null; locationScope?: LocationScope; reason?: string };
interface Body { commandId?: string; type?: string; membershipId?: string; actorUserId?: string; expectedRevision?: number; changes?: Changes }
type MemberRow = { id: string; role: Role; custom_role_id: string | null; permissions: unknown; membership_revision: string; is_active: boolean; membership_status: string; custom_permissions: string[] | null; location_scope: LocationScope; location_id: string | null; location_ids: string[] };
class CommandError extends Error { constructor(message: string, public status = 403) { super(message); } }

export async function POST(request: NextRequest) {
  const site = await authenticateIamSite(request);
  if (!site) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as Body | null;
  if (!body?.commandId || !UUID.test(body.commandId) || !body.membershipId || !UUID.test(body.membershipId) ||
      !body.actorUserId || !UUID.test(body.actorUserId) || !Number.isSafeInteger(body.expectedRevision) || !body.type) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  return withTenant(site.businessId, async () => {
    const client = await getPool().connect();
    let inserted = false;
    try {
      await client.query("BEGIN");
      const prior = await client.query<{ status: string; result: unknown }>(
        `SELECT status,result FROM iam_commands
          WHERE business_id=$1 AND site_device_id=$2 AND command_id=$3 FOR UPDATE`,
        [site.businessId, site.siteDeviceId, body.commandId],
      );
      if (prior.rows[0]) {
        await client.query("COMMIT");
        return NextResponse.json(prior.rows[0].result, { status: prior.rows[0].status === "accepted" ? 200 : 409 });
      }
      await client.query(
        `INSERT INTO iam_commands
          (business_id,site_device_id,command_id,command_type,membership_id,expected_revision,payload,actor_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [site.businessId, site.siteDeviceId, body.commandId, body.type, body.membershipId,
          body.expectedRevision, JSON.stringify(body.changes ?? {}), body.actorUserId],
      );
      inserted = true;

      const members = await client.query<MemberRow>(
        `SELECT u.id,u.role,u.custom_role_id,u.permissions,u.membership_revision,u.is_active,u.membership_status,u.location_scope,u.location_id,
                coalesce(ARRAY(SELECT ul.location_id FROM user_locations ul WHERE ul.user_id=u.id),'{}') location_ids,
                CASE WHEN tr.is_active THEN ARRAY(SELECT jsonb_array_elements_text(tr.permissions)) END custom_permissions
           FROM users u
           LEFT JOIN tenant_roles tr ON tr.id=u.custom_role_id AND tr.business_id=u.business_id
          WHERE u.business_id=$1 AND u.id=ANY($2::uuid[]) FOR UPDATE OF u`,
        [site.businessId, [body.actorUserId, body.membershipId]],
      );
      const actor = members.rows.find((row) => row.id === body.actorUserId);
      const target = members.rows.find((row) => row.id === body.membershipId);
      if (!actor?.is_active || actor.membership_status !== "active" || !target) throw new CommandError("command_forbidden");
      const actorPermissions = effectivePermissions(actor.role, parseOverrides(actor.permissions), actor.custom_permissions);
      if (!actorPermissions.has(PERMISSIONS.teamPermissionsManage)) throw new CommandError("command_forbidden");
      if (Number(target.membership_revision) !== body.expectedRevision) throw new CommandError("revision_conflict", 409);

      const changes = body.changes ?? {};
      let eventType: IamEventType;
      let payload: Record<string, unknown> = {};
      switch (body.type) {
        case "membership.permissions.change": {
          if (!changes.permissions) throw new CommandError("invalid_command", 400);
          const next = parseOverrides(changes.permissions);
          const nextEffective = effectivePermissions(target.role, next, target.custom_permissions);
          if ([...nextEffective].some((permission) => !actorPermissions.has(permission))) throw new CommandError("privilege_escalation");
          await client.query(`UPDATE users SET permissions=$3,membership_revision=membership_revision+1,updated_at=now() WHERE business_id=$1 AND id=$2`, [site.businessId, target.id, JSON.stringify(next)]);
          eventType = "membership.permissions_changed"; payload = { permissions: next }; break;
        }
        case "membership.system_role.change": {
          if (!changes.role || !ASSIGNABLE_ROLES.includes(changes.role)) throw new CommandError("invalid_role", 400);
          if ((changes.role === "owner" || target.role === "owner") && actor.role !== "owner") throw new CommandError("owner_only");
          const nextEffective = effectivePermissions(changes.role, parseOverrides(target.permissions));
          if ([...nextEffective].some((permission) => !actorPermissions.has(permission)) && actor.role !== "owner") throw new CommandError("privilege_escalation");
          await client.query(`UPDATE users SET role=$3,custom_role_id=NULL,membership_revision=membership_revision+1,updated_at=now() WHERE business_id=$1 AND id=$2`, [site.businessId, target.id, changes.role]);
          eventType = "membership.system_role_changed"; payload = { role: changes.role }; break;
        }
        case "membership.custom_role.change": {
          let rolePermissions: string[];
          if (changes.customRoleId) {
            if (!UUID.test(changes.customRoleId)) throw new CommandError("invalid_role", 400);
            const custom = await client.query<{ permissions: string[] }>(`SELECT ARRAY(SELECT jsonb_array_elements_text(permissions)) permissions FROM tenant_roles WHERE business_id=$1 AND id=$2 AND is_active`, [site.businessId, changes.customRoleId]);
            if (!custom.rows[0]) throw new CommandError("custom_role_not_found", 404);
            rolePermissions = custom.rows[0].permissions;
          } else rolePermissions = [...effectivePermissions(target.role, parseOverrides(target.permissions))];
          if (rolePermissions.some((permission) => !actorPermissions.has(permission as Permission))) throw new CommandError("privilege_escalation");
          await client.query(`UPDATE users SET custom_role_id=$3,membership_revision=membership_revision+1,updated_at=now() WHERE business_id=$1 AND id=$2`, [site.businessId, target.id, changes.customRoleId ?? null]);
          eventType = "membership.custom_role_changed"; payload = { customRoleId: changes.customRoleId ?? null }; break;
        }
        case "membership.locations.change": {
          if (!Array.isArray(changes.locationIds) || !isLocationScope(changes.locationScope)) throw new CommandError("invalid_location_scope", 400);
          const ids = [...new Set(changes.locationIds)]; if (changes.defaultLocationId) ids.push(changes.defaultLocationId);
          const locations = await client.query<{ id: string }>(`SELECT id FROM locations WHERE business_id=$1 AND is_active ORDER BY created_at,id`, [site.businessId]);
          const businessLocationIds = locations.rows.map((row) => row.id);
          if (ids.some((id) => !businessLocationIds.includes(id))) throw new CommandError("invalid_location_scope", 400);
          const actorLocations = new Set(accessibleLocationIds({ role: actor.role, locationScope: actor.location_scope, defaultLocationId: actor.location_id, assignedLocationIds: actor.location_ids }, businessLocationIds));
          const requestedLocations = accessibleLocationIds({ role: target.role, locationScope: changes.locationScope, defaultLocationId: changes.defaultLocationId ?? null, assignedLocationIds: changes.locationIds }, businessLocationIds);
          if (requestedLocations.some((id) => !actorLocations.has(id))) throw new CommandError("location_scope_escalation");
          await client.query(`UPDATE users SET location_scope=$3,location_id=$4,membership_revision=membership_revision+1,updated_at=now() WHERE business_id=$1 AND id=$2`, [site.businessId, target.id, changes.locationScope, changes.defaultLocationId ?? null]);
          await client.query(`DELETE FROM user_locations WHERE user_id=$1`, [target.id]);
          if (changes.locationIds.length) await client.query(`INSERT INTO user_locations(user_id,location_id) SELECT $1,unnest($2::uuid[])`, [target.id, changes.locationIds]);
          eventType = "membership.locations_changed"; payload = { locationIds: changes.locationIds, locationScope: changes.locationScope, defaultLocationId: changes.defaultLocationId ?? null }; break;
        }
        case "membership.suspend": {
          if (target.role === "owner") {
            if (actor.role !== "owner") throw new CommandError("owner_only");
            const owners = await client.query(`SELECT 1 FROM users WHERE business_id=$1 AND role='owner' AND is_active AND id<>$2 LIMIT 1`, [site.businessId, target.id]);
            if (!owners.rowCount) throw new CommandError("last_owner", 409);
          }
          await client.query(`UPDATE users SET is_active=false,membership_status='suspended',membership_revision=membership_revision+1 WHERE business_id=$1 AND id=$2`, [site.businessId, target.id]);
          eventType = "membership.suspended"; break;
        }
        case "membership.reactivate": throw new CommandError("cloud_reactivation_required", 403);
        case "membership.offboard": {
          if (target.role === "owner") {
            if (actor.role !== "owner") throw new CommandError("owner_only");
            const owners = await client.query(`SELECT 1 FROM users WHERE business_id=$1 AND role='owner' AND is_active AND id<>$2 LIMIT 1`, [site.businessId, target.id]);
            if (!owners.rowCount) throw new CommandError("last_owner", 409);
          }
          await client.query(`UPDATE users SET is_active=false,membership_status='offboarded',location_scope='none',membership_revision=membership_revision+1 WHERE business_id=$1 AND id=$2`, [site.businessId, target.id]);
          eventType = "membership.offboarded"; break;
        }
        default: throw new CommandError("unsupported_command", 400);
      }

      const revised = await client.query<{ membership_revision: string }>(`SELECT membership_revision FROM users WHERE business_id=$1 AND id=$2`, [site.businessId, target.id]);
      const revision = Number(revised.rows[0].membership_revision);
      if (["membership.suspend", "membership.offboard"].includes(body.type)) {
        await client.query(`UPDATE employee_sessions SET revoked_at=now() WHERE business_id=$1 AND employee_id=$2 AND revoked_at IS NULL`, [site.businessId, target.id]);
        await client.query(`UPDATE employee_credentials SET status='revoked',revoked_at=now() WHERE business_id=$1 AND employee_id=$2 AND status='active'`, [site.businessId, target.id]);
      }
      const iamSequence = await appendIamEvent(client, { businessId: site.businessId, type: eventType, entityId: target.id, payload: { ...payload, revision, reason: changes.reason ?? null }, actorUserId: actor.id, origin: "site_command" });
      const result = { ok: true, revision, iamSequence };
      await client.query(`UPDATE iam_commands SET status='accepted',result=$4,completed_at=now() WHERE business_id=$1 AND site_device_id=$2 AND command_id=$3`, [site.businessId, site.siteDeviceId, body.commandId, JSON.stringify(result)]);
      await client.query(`INSERT INTO audit_log(business_id,user_id,action,entity,entity_id,payload) VALUES($1,$2,'iam.command_accepted','user',$3,$4)`, [site.businessId, actor.id, target.id, JSON.stringify({ commandId: body.commandId, type: body.type, revision, reason: changes.reason ?? null, siteDeviceId: site.siteDeviceId })]);
      await client.query("COMMIT");
      return NextResponse.json(result);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      const code = error instanceof Error ? error.message : "command_rejected";
      const status = error instanceof CommandError ? error.status : 403;
      const result = { ok: false, error: code };
      if (inserted) await query(
        `INSERT INTO iam_commands(business_id,site_device_id,command_id,command_type,membership_id,expected_revision,payload,status,result,actor_user_id,completed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) ON CONFLICT(business_id,site_device_id,command_id) DO NOTHING`,
        [site.businessId, site.siteDeviceId, body.commandId, body.type, body.membershipId, body.expectedRevision, JSON.stringify(body.changes ?? {}), code === "revision_conflict" ? "conflict" : "rejected", JSON.stringify(result), body.actorUserId],
      ).catch(() => {});
      return NextResponse.json(result, { status });
    } finally { client.release(); }
  });
}
