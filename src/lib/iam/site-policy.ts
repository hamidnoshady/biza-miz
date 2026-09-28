import { getPool, query } from "../db";
import { readDeploymentProfile } from "../deployment-mode";
import { ALL_PERMISSIONS } from "../permissions";
import { SETTING_KEYS, getSetting } from "../settings";

export class SitePolicyError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

interface SyncConfig { siteDeviceId?: string }

/** Hybrid-only deny/narrow mutation. Its input shape contains no grant. */
export async function restrictSiteMember(input: { businessId:string; userId:string; actorId:string;
  permissionDenies?: string[]; allowedLocationIds?: string[] | null; isLocallySuspended?: boolean; localLoginLocked?: boolean; reason?: string | null;
}): Promise<void> {
  if ((await readDeploymentProfile(input.businessId)).profile !== "hybrid") throw new SitePolicyError("hybrid_only", 409);
  const config = await getSetting<SyncConfig>(input.businessId, SETTING_KEYS.serverSyncConfig);
  if (!config?.siteDeviceId) throw new SitePolicyError("site_not_configured", 409);
  const denies = [...new Set(input.permissionDenies ?? [])];
  if (denies.some((p) => !(ALL_PERMISSIONS as readonly string[]).includes(p))) throw new SitePolicyError("invalid_permission");
  const locations = input.allowedLocationIds === undefined ? undefined : input.allowedLocationIds === null ? null : [...new Set(input.allowedLocationIds)];
  if (locations?.length) {
    const canonical = await query<{id:string}>(
      `SELECT l.id FROM locations l JOIN users u ON u.id=$2 AND u.business_id=l.business_id
       WHERE l.business_id=$1 AND l.is_active AND (
         u.location_scope='all' OR (u.location_scope='home' AND u.location_id=l.id) OR
         (u.location_scope='selected' AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id=u.id AND ul.location_id=l.id))
       ) AND l.id=ANY($3::uuid[])`, [input.businessId,input.userId,locations]);
    if (canonical.rows.length !== locations.length) throw new SitePolicyError("site_cannot_widen_locations", 409);
  }
  const client=await getPool().connect();
  try {
    await client.query("BEGIN");
    const member=await client.query("SELECT 1 FROM users WHERE id=$1 AND business_id=$2",[input.userId,input.businessId]);
    if (!member.rowCount) throw new SitePolicyError("not_found",404);
    await client.query(
      `INSERT INTO site_member_access (business_id,site_device_id,user_id,permission_denies,allowed_location_ids,is_locally_suspended,local_login_locked)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (business_id,site_device_id,user_id) DO UPDATE SET
         permission_denies=EXCLUDED.permission_denies,
         allowed_location_ids=CASE WHEN $8::boolean THEN EXCLUDED.allowed_location_ids ELSE site_member_access.allowed_location_ids END,
         is_locally_suspended=EXCLUDED.is_locally_suspended,local_login_locked=EXCLUDED.local_login_locked,
         revision=site_member_access.revision+1,updated_at=now()`,
      [input.businessId,config.siteDeviceId,input.userId,JSON.stringify(denies),locations ?? null,
       input.isLocallySuspended ?? false,input.localLoginLocked ?? false,input.allowedLocationIds !== undefined]);
    if (input.isLocallySuspended || input.localLoginLocked) {
      await client.query(`UPDATE employee_sessions SET revoked_at=now() WHERE business_id=$1 AND employee_id=$2 AND revoked_at IS NULL`,[input.businessId,input.userId]);
    }
    await client.query(`INSERT INTO audit_log (business_id,user_id,action,entity,entity_id,payload)
      VALUES ($1,$2,'team.site_restricted','user',$3,$4)`,[input.businessId,input.actorId,input.userId,
      JSON.stringify({permissionDenies:denies,allowedLocationIds:locations,isLocallySuspended:input.isLocallySuspended ?? false,
        localLoginLocked:input.localLoginLocked ?? false,reason:input.reason ?? null,origin:"site"})]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(()=>{}); throw error; } finally { client.release(); }
}
