import { getPool, query } from "../db";
import { getSetting, SETTING_KEYS } from "../settings";
import type { ServerSyncConfig } from "../server-sync-config";
import type { IamEvent, IamSnapshot } from "./model";
import { iamStateHash, sequenceDecision } from "./reconciliation";
import { validateIamEvent } from "./events";
import { buildIamSnapshot } from "./service";
import { syncHybridLoginCredentials } from "./login-credential-sync";

function baseUrl(value:string){return value.trim().replace(/\/+$/,"");}

async function mark(businessId:string,siteDeviceId:string,status:string,error:string|null,lastSequence?:number){
  await query(`INSERT INTO iam_sync_state (business_id,site_device_id,status,last_error,last_attempt_at,last_sequence,last_success_at)
    VALUES ($1,$2,$3,$4,now(),COALESCE($5,0),CASE WHEN $3='healthy' THEN now() END)
    ON CONFLICT (business_id,site_device_id) DO UPDATE SET status=$3,last_error=$4,last_attempt_at=now(),
      last_sequence=COALESCE($5,iam_sync_state.last_sequence),last_success_at=CASE WHEN $3='healthy' THEN now() ELSE iam_sync_state.last_success_at END`,
    [businessId,siteDeviceId,status,error,lastSequence??null]);
}

async function applySnapshot(businessId:string,siteDeviceId:string,snapshot:IamSnapshot):Promise<void>{
  if(snapshot.schemaVersion!==1||snapshot.businessId!==businessId||snapshot.siteDeviceId!==siteDeviceId) throw new Error("snapshot_identity_mismatch");
  if(iamStateHash(snapshot.memberships,snapshot.tenantRoles)!==snapshot.stateHash) throw new Error("snapshot_checksum_mismatch");
  const client=await getPool().connect();
  try{await client.query("BEGIN");
    for(const role of snapshot.tenantRoles) await client.query(`INSERT INTO tenant_roles
      (id,business_id,name,description,permissions,default_location_scope,is_active,role_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,
      permissions=EXCLUDED.permissions,default_location_scope=EXCLUDED.default_location_scope,is_active=EXCLUDED.is_active,role_revision=EXCLUDED.role_revision`,
      [role.id,businessId,role.name,role.description,JSON.stringify(role.permissions),role.defaultLocationScope,role.isActive,role.revision]);
    const roleIds=snapshot.tenantRoles.map(r=>r.id);
    if(roleIds.length) await client.query(`UPDATE tenant_roles SET is_active=false WHERE business_id=$1 AND NOT(id=ANY($2::uuid[]))`,[businessId,roleIds]);
    for(const member of snapshot.memberships){
      await client.query(`INSERT INTO users(id,business_id,role,custom_role_id,full_name,email,is_active,membership_status,permissions,location_scope,location_id,membership_revision)
        VALUES($2,$1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO UPDATE SET role=EXCLUDED.role,custom_role_id=EXCLUDED.custom_role_id,
        full_name=EXCLUDED.full_name,email=EXCLUDED.email,is_active=EXCLUDED.is_active,membership_status=EXCLUDED.membership_status,
        permissions=EXCLUDED.permissions,location_scope=EXCLUDED.location_scope,location_id=EXCLUDED.location_id,
        membership_revision=EXCLUDED.membership_revision,updated_at=now() WHERE users.business_id=$1`,
        [businessId,member.id,member.role,member.customRoleId,member.fullName,member.email,member.isActive,member.status,
          JSON.stringify(member.overrides),member.locationScope,member.defaultLocationId,member.revision]);
      await client.query(`DELETE FROM user_locations WHERE user_id=$1`,[member.id]);
      if(member.locationIds.length) await client.query(`INSERT INTO user_locations(user_id,location_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,[member.id,member.locationIds]);
      if(!member.isActive||member.status!=="active") await client.query(`UPDATE employee_sessions SET revoked_at=now() WHERE business_id=$1 AND employee_id=$2 AND revoked_at IS NULL`,[businessId,member.id]);
    }
    const memberIds=snapshot.memberships.map(m=>m.id);
    if(memberIds.length) await client.query(`UPDATE users SET is_active=false,membership_status='offboarded',location_scope='none',membership_revision=membership_revision+1
      WHERE business_id=$1 AND NOT(id=ANY($2::uuid[]))`,[businessId,memberIds]);
    await client.query(`INSERT INTO iam_business_sequences(business_id,last_sequence) VALUES($1,$2) ON CONFLICT(business_id) DO UPDATE SET last_sequence=GREATEST(iam_business_sequences.last_sequence,EXCLUDED.last_sequence)`,[businessId,snapshot.lastSequence]);
    await client.query(`UPDATE iam_sync_state SET last_sequence=$3,last_snapshot_version=$4,last_snapshot_hash=$5,status='healthy',last_error=NULL,last_success_at=now()
      WHERE business_id=$1 AND site_device_id=$2`,[businessId,siteDeviceId,snapshot.lastSequence,snapshot.snapshotVersion,snapshot.stateHash]);
    await client.query("COMMIT");
    const { disconnectMember } = await import("../realtime");
    for (const member of snapshot.memberships) if (!member.isActive || member.status !== "active") disconnectMember(businessId, member.id, "Cloud access revoked");
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
}

export async function applyIamEvents(businessId:string,siteDeviceId:string,lastSequence:number,events:IamEvent[]):Promise<number>{
  let cursor=lastSequence;
  const client=await getPool().connect();
  try{await client.query("BEGIN");
    for(const raw of events){
      const decision=sequenceDecision(cursor,raw);
      if(decision.action==="ignore_duplicate") continue;
      if(decision.action==="recover_gap") throw new Error(`sequence_gap:${decision.expected}:${decision.received}`);
      if(decision.action==="dead_letter") {
        const candidate=raw as IamEvent;
        await client.query(`INSERT INTO iam_dead_letters(business_id,site_device_id,sequence,event_type,schema_version,payload,error_code)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(business_id,site_device_id,sequence) DO UPDATE SET retry_count=iam_dead_letters.retry_count+1,last_seen_at=now(),error_code=EXCLUDED.error_code`,
          [businessId,siteDeviceId,candidate.sequence,candidate.eventType,candidate.schemaVersion,JSON.stringify(candidate.payload),decision.code]);
        await client.query(`UPDATE iam_sync_state SET status='snapshot_required',last_error=$3,last_attempt_at=now() WHERE business_id=$1 AND site_device_id=$2`,[businessId,siteDeviceId,decision.code]);
        await client.query("COMMIT");
        throw new Error(decision.code);
      }
      const validated=validateIamEvent(raw); if(!validated.ok) throw new Error(validated.code); const event=validated.event;
      if(event.businessId!==businessId) throw new Error("event_tenant_mismatch");
      const revision=Number(event.payload.revision??0);
      if(event.entityType==="membership"){
        if(event.eventType==="membership.created") {
          const member=event.payload.membership as IamSnapshot["memberships"][number] | undefined;
          if(!member || member.businessId!==businessId) throw new Error("invalid_membership_created");
          await client.query(`INSERT INTO users(id,business_id,role,custom_role_id,full_name,email,is_active,membership_status,permissions,location_scope,location_id,membership_revision)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,[member.id,businessId,member.role,member.customRoleId,
            member.fullName,member.email,member.isActive,member.status,JSON.stringify(member.overrides),member.locationScope,member.defaultLocationId,member.revision]);
          if(member.locationIds.length) await client.query(`INSERT INTO user_locations(user_id,location_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,[member.id,member.locationIds]);
        } else if(event.eventType==="membership.suspended"||event.eventType==="membership.offboarded"){
          const status=event.eventType==="membership.suspended"?"suspended":"offboarded";
          // `$3::membership_status` matters: without the cast Postgres cannot
          // pick one type for a parameter used both as the enum column value
          // and against a text literal, and every suspension/offboarding event
          // failed with "inconsistent types deduced for parameter $3" — so a
          // member suspended on the cloud kept local login access.
          await client.query(`UPDATE users SET is_active=false,membership_status=$3::membership_status,
            location_scope=CASE WHEN $3::membership_status='offboarded' THEN 'none'::location_scope ELSE location_scope END,
            membership_revision=GREATEST(membership_revision,$4) WHERE business_id=$1 AND id=$2`,[businessId,event.entityId,status,revision]);
          await client.query(`UPDATE employee_sessions SET revoked_at=now() WHERE business_id=$1 AND employee_id=$2 AND revoked_at IS NULL`,[businessId,event.entityId]);
          // The cloud revokes a suspended/offboarded staff member's PIN, so the
          // replica must too: `is_active=false` alone stops the roster and the
          // PIN door, but the hash would still sit there as an *active*
          // credential — and would come back to life if the member were later
          // reactivated while the cloud no longer publishes a PIN for them.
          // Only the cloud-owned PIN roles (cashier/waiter/kitchen) are
          // revoked: a password-role member's PIN is this install's own offline
          // door (see src/lib/iam/login-credentials.ts), and suspension already
          // blocks them through is_active.
          await client.query(`UPDATE employee_credentials SET status='revoked',revoked_at=now()
            WHERE business_id=$1 AND employee_id=$2 AND credential_type='pin' AND status='active'
              AND EXISTS (SELECT 1 FROM users u WHERE u.id=$2 AND u.business_id=$1 AND u.role IN ('cashier','waiter','kitchen'))`,
            [businessId,event.entityId]);
          await client.query(`UPDATE users SET pin_hash=NULL
            WHERE business_id=$1 AND id=$2 AND pin_hash IS NOT NULL AND role IN ('cashier','waiter','kitchen')`,
            [businessId,event.entityId]);
        }else if(event.eventType==="membership.permissions_changed") await client.query(`UPDATE users SET permissions=$3,membership_revision=GREATEST(membership_revision,$4) WHERE business_id=$1 AND id=$2`,
          [businessId,event.entityId,JSON.stringify(event.payload.permissions??(event.payload.changes as {overrides?:unknown}|undefined)?.overrides??{}),revision]);
        else if(event.eventType==="membership.system_role_changed") {
          const changes=(event.payload.changes??event.payload) as {role?:string};
          await client.query(`UPDATE users SET role=COALESCE(($3->>'role')::user_role,role),custom_role_id=NULL,membership_revision=GREATEST(membership_revision,$4) WHERE business_id=$1 AND id=$2`,
            [businessId,event.entityId,JSON.stringify(changes),revision]);
        } else if(event.eventType==="membership.custom_role_changed") {
          const changes=(event.payload.changes??event.payload) as {customRoleId?:string|null};
          await client.query(`UPDATE users SET custom_role_id=$3,membership_revision=GREATEST(membership_revision,$4) WHERE business_id=$1 AND id=$2`,
            [businessId,event.entityId,changes.customRoleId??null,revision]);
        } else if(event.eventType==="membership.locations_changed"||event.eventType==="membership.location_policy_changed") {
          const changes=(event.payload.changes??event.payload) as {locationIds?:string[];locationScope?:string;defaultLocationId?:string|null};
          await client.query(`UPDATE users SET location_scope=COALESCE($3::location_scope,location_scope),location_id=CASE WHEN $4::boolean THEN $5::uuid ELSE location_id END,membership_revision=GREATEST(membership_revision,$6) WHERE business_id=$1 AND id=$2`,
            [businessId,event.entityId,changes.locationScope??null,"defaultLocationId" in changes,changes.defaultLocationId??null,revision]);
          if(Array.isArray(changes.locationIds)){
            await client.query(`DELETE FROM user_locations WHERE user_id=$1`,[event.entityId]);
            if(changes.locationIds.length)await client.query(`INSERT INTO user_locations(user_id,location_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,[event.entityId,changes.locationIds]);
          }
        } else if(event.eventType==="membership.profile_updated") {
          const changes=event.payload.changes as {fullName?:string}|undefined;
          await client.query(`UPDATE users SET full_name=COALESCE($3,full_name),membership_revision=GREATEST(membership_revision,$4) WHERE business_id=$1 AND id=$2`,[businessId,event.entityId,changes?.fullName??null,revision]);
        } else if(event.eventType==="membership.reactivated") {
          await client.query(`UPDATE users SET is_active=true,membership_status='active',membership_revision=GREATEST(membership_revision,$3) WHERE business_id=$1 AND id=$2`,[businessId,event.entityId,revision]);
        }
      } else if(event.entityType==="tenant_role") {
        const role=event.payload.role as IamSnapshot["tenantRoles"][number]|undefined;
        if(!role||role.id!==event.entityId)throw new Error("invalid_tenant_role_event");
        await client.query(`INSERT INTO tenant_roles(id,business_id,name,description,permissions,default_location_scope,is_active,role_revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,
          permissions=EXCLUDED.permissions,default_location_scope=EXCLUDED.default_location_scope,is_active=EXCLUDED.is_active,
          role_revision=GREATEST(tenant_roles.role_revision,EXCLUDED.role_revision) WHERE tenant_roles.business_id=$2`,
          [role.id,businessId,role.name,role.description,JSON.stringify(role.permissions),role.defaultLocationScope,role.isActive,role.revision]);
      }
      cursor=event.sequence;
    }
    await client.query(`INSERT INTO iam_business_sequences(business_id,last_sequence) VALUES($1,$2) ON CONFLICT(business_id) DO UPDATE SET last_sequence=GREATEST(iam_business_sequences.last_sequence,EXCLUDED.last_sequence)`,[businessId,cursor]);
    await client.query(`UPDATE iam_sync_state SET last_sequence=$3,status='healthy',last_error=NULL,last_attempt_at=now(),last_success_at=now() WHERE business_id=$1 AND site_device_id=$2`,[businessId,siteDeviceId,cursor]);
    await client.query("COMMIT");
    const { disconnectMember } = await import("../realtime");
    for (const event of events) if (event.eventType === "membership.suspended" || event.eventType === "membership.offboarded") disconnectMember(businessId, event.entityId, "Cloud access revoked");
    return cursor;
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
}

/** Security sync gate. False means ordinary business sync must not start. */
export async function runIamSync(businessId:string):Promise<boolean>{
  const config=await getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
  if(!config?.enabled||!config.remoteUrl?.trim()||!config.token?.trim()||!config.siteDeviceId) return false;
  const state=await query<{last_sequence:string;status:string}>(`SELECT last_sequence,status FROM iam_sync_state WHERE business_id=$1 AND site_device_id=$2`,[businessId,config.siteDeviceId]);
  const current=state.rows[0]??{last_sequence:"0",status:"snapshot_required"};
  try{
    await mark(businessId,config.siteDeviceId,"syncing",null);
    if(current.status==="snapshot_required"){
      const response=await fetch(`${baseUrl(config.remoteUrl)}/api/iam/snapshot`,{headers:{Authorization:`Bearer ${config.token}`},signal:AbortSignal.timeout(30_000)});
      if(!response.ok) throw new Error(`snapshot_http_${response.status}`);
      const body=await response.json() as {snapshot:IamSnapshot}; await applySnapshot(businessId,config.siteDeviceId,body.snapshot);
    }
    const fresh=await query<{last_sequence:string}>(`SELECT last_sequence FROM iam_sync_state WHERE business_id=$1 AND site_device_id=$2`,[businessId,config.siteDeviceId]);
    const after=Number(fresh.rows[0]?.last_sequence??current.last_sequence);
    const response=await fetch(`${baseUrl(config.remoteUrl)}/api/iam/events?after=${after}&limit=200`,{headers:{Authorization:`Bearer ${config.token}`},signal:AbortSignal.timeout(30_000)});
    if(!response.ok) throw new Error(`events_http_${response.status}`);
    const body=await response.json() as {events:IamEvent[]}; const appliedSequence=await applyIamEvents(businessId,config.siteDeviceId,after,body.events??[]);
    // Deterministic drift check. Security state is small and correctness is more
    // important than merging an unexplained difference.
    const snapshotResponse=await fetch(`${baseUrl(config.remoteUrl)}/api/iam/snapshot`,{headers:{Authorization:`Bearer ${config.token}`},signal:AbortSignal.timeout(30_000)});
    if(!snapshotResponse.ok)throw new Error(`drift_snapshot_http_${snapshotResponse.status}`);
    const cloud=(await snapshotResponse.json() as {snapshot:IamSnapshot}).snapshot;
    const local=await buildIamSnapshot(businessId,config.siteDeviceId);
    if(local.stateHash!==cloud.stateHash||appliedSequence!==cloud.lastSequence){
      await mark(businessId,config.siteDeviceId,"snapshot_required","iam_drift_detected");
      await applySnapshot(businessId,config.siteDeviceId,cloud);
    }
    // Login credentials are their own plane, not a best-effort appendix to the
    // membership one: a site can be perfectly converged on memberships while
    // every cloud-created PIN is still missing locally. The reconciliation
    // records its own durable status (healthy/degraded/…), which the login
    // screen, the connection panel and the repair action all read — so a
    // failure here is visible instead of a console line. It deliberately does
    // not flip this function's return value: ordinary business sync keeps
    // running (the product decision that predates this), but the installation
    // is no longer reported as fully healthy.
    const credentialSync=await syncHybridLoginCredentials(businessId,{config});
    if(credentialSync.status==="degraded") console.error(`login credential sync degraded: ${credentialSync.error}`);
    return true;
  }catch(error){const message=error instanceof Error?error.message:String(error);await mark(businessId,config.siteDeviceId,message.startsWith("sequence_gap")?"snapshot_required":"degraded",message);return false;}
}
