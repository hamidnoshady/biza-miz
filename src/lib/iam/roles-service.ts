import type { PoolClient } from "pg";
import { getPool, query } from "../db";
import { readDeploymentProfile } from "../deployment-mode";
import { ALL_PERMISSIONS, effectivePermissions, parseOverrides, type Permission } from "../permissions";
import type { Role } from "../auth-edge";
import type { LocationScope } from "../location-access";
import { appendIamEvent } from "./service";

export class TenantRoleError extends Error { constructor(public code:string,public status=400){super(code);} }
export interface TenantRoleView {id:string;name:string;description:string;permissions:string[];defaultLocationScope:LocationScope;isActive:boolean;revision:number;memberCount:number;createdAt:string;updatedAt:string}

function validPermissions(values:unknown):string[]{
  if(!Array.isArray(values)) throw new TenantRoleError("invalid_permissions");
  const result=[...new Set(values.filter((v):v is string=>typeof v==="string"))];
  if(result.length!==values.length||result.some(v=>!(ALL_PERMISSIONS as readonly string[]).includes(v))) throw new TenantRoleError("invalid_permissions");
  return result;
}
async function origin(businessId:string){const p=(await readDeploymentProfile(businessId)).profile;if(p==="hybrid")throw new TenantRoleError("cloud_confirmation_required",409);return p==="local"?"local" as const:"cloud" as const;}
async function assertDelegable(client:{query:PoolClient["query"]},businessId:string,actorId:string,permissions:string[]){
  const {rows}=await client.query<{role:Role;permissions:unknown;custom_permissions:string[]|null}>(`SELECT u.role,u.permissions,
    CASE WHEN tr.is_active THEN ARRAY(SELECT jsonb_array_elements_text(tr.permissions)) END custom_permissions FROM users u
    LEFT JOIN tenant_roles tr ON tr.id=u.custom_role_id AND tr.business_id=u.business_id WHERE u.business_id=$1 AND u.id=$2 AND u.is_active`,[businessId,actorId]);
  const actor=rows[0];if(!actor)throw new TenantRoleError("actor_inactive",403);
  const held=effectivePermissions(actor.role,parseOverrides(actor.permissions),actor.custom_permissions);
  if(permissions.some(p=>!held.has(p as Permission)))throw new TenantRoleError("privilege_escalation",403);
}
export async function listTenantRoles(businessId:string):Promise<TenantRoleView[]>{
  const {rows}=await query<{id:string;name:string;description:string;permissions:string[];default_location_scope:LocationScope;is_active:boolean;role_revision:string;member_count:string;created_at:Date;updated_at:Date}>(
    `SELECT tr.id,tr.name,tr.description,ARRAY(SELECT jsonb_array_elements_text(tr.permissions)) permissions,tr.default_location_scope,tr.is_active,tr.role_revision,
      count(u.id)::text member_count,tr.created_at,tr.updated_at FROM tenant_roles tr LEFT JOIN users u ON u.custom_role_id=tr.id AND u.membership_status<>'offboarded'
      WHERE tr.business_id=$1 GROUP BY tr.id ORDER BY tr.is_active DESC,tr.name`,[businessId]);
  return rows.map(r=>({id:r.id,name:r.name,description:r.description,permissions:r.permissions,defaultLocationScope:r.default_location_scope,isActive:r.is_active,
    revision:Number(r.role_revision),memberCount:Number(r.member_count),createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString()}));
}
export async function createTenantRole(input:{businessId:string;actorId:string;name:string;description?:string;permissions:unknown;defaultLocationScope?:LocationScope;reason?:string}){
  const eventOrigin=await origin(input.businessId),name=input.name.trim(),permissions=validPermissions(input.permissions);if(!name||name.length>80)throw new TenantRoleError("invalid_name");
  const client=await getPool().connect();try{await client.query("BEGIN");await assertDelegable(client,input.businessId,input.actorId,permissions);
    const {rows}=await client.query<{id:string;description:string;default_location_scope:LocationScope;is_active:boolean}>(`INSERT INTO tenant_roles(business_id,name,description,permissions,default_location_scope,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id,description,default_location_scope,is_active`,[input.businessId,name,input.description?.trim()??"",JSON.stringify(permissions),input.defaultLocationScope??"selected",input.actorId]);
    await appendIamEvent(client,{businessId:input.businessId,type:"tenant_role.created",entityId:rows[0].id,payload:{revision:1,role:{id:rows[0].id,name,description:rows[0].description,permissions,defaultLocationScope:rows[0].default_location_scope,isActive:rows[0].is_active,revision:1},reason:input.reason??null},actorUserId:input.actorId,origin:eventOrigin});
    await client.query(`INSERT INTO audit_log(business_id,user_id,action,entity,entity_id,payload) VALUES($1,$2,'team.custom_role_created','tenant_role',$3,$4)`,[input.businessId,input.actorId,rows[0].id,JSON.stringify({name,permissions,reason:input.reason??null})]);
    await client.query("COMMIT");return rows[0].id;}catch(e){await client.query("ROLLBACK").catch(()=>{});if((e as {code?:string}).code==="23505")throw new TenantRoleError("role_name_taken",409);throw e;}finally{client.release();}
}
export async function updateTenantRole(input:{businessId:string;actorId:string;roleId:string;expectedRevision:number;name?:string;description?:string;permissions?:unknown;isActive?:boolean;reason?:string}){
  const eventOrigin=await origin(input.businessId),permissions=input.permissions===undefined?undefined:validPermissions(input.permissions);
  const client=await getPool().connect();try{await client.query("BEGIN");if(permissions)await assertDelegable(client,input.businessId,input.actorId,permissions);
    if(input.isActive===false){const assigned=await client.query(`SELECT 1 FROM users WHERE business_id=$1 AND custom_role_id=$2 AND membership_status<>'offboarded' LIMIT 1`,[input.businessId,input.roleId]);if(assigned.rowCount)throw new TenantRoleError("role_in_use",409);}
    const {rows}=await client.query<{role_revision:string;name:string;description:string;permissions:string[];default_location_scope:LocationScope;is_active:boolean}>(`UPDATE tenant_roles SET name=COALESCE($4,name),description=COALESCE($5,description),permissions=COALESCE($6,permissions),
      is_active=COALESCE($7,is_active),role_revision=role_revision+1,updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2 AND role_revision=$8
      RETURNING role_revision,name,description,ARRAY(SELECT jsonb_array_elements_text(permissions)) permissions,default_location_scope,is_active`,
      [input.businessId,input.roleId,input.actorId,input.name?.trim()||null,input.description?.trim()??null,permissions?JSON.stringify(permissions):null,input.isActive??null,input.expectedRevision]);
    if(!rows[0])throw new TenantRoleError("revision_conflict",409);const revision=Number(rows[0].role_revision),type=input.isActive===false?"tenant_role.archived":permissions?"tenant_role.permissions_changed":"tenant_role.updated";
    await appendIamEvent(client,{businessId:input.businessId,type,entityId:input.roleId,payload:{revision,role:{id:input.roleId,name:rows[0].name,description:rows[0].description,permissions:rows[0].permissions,defaultLocationScope:rows[0].default_location_scope,isActive:rows[0].is_active,revision},reason:input.reason??null},actorUserId:input.actorId,origin:eventOrigin});
    await client.query(`INSERT INTO audit_log(business_id,user_id,action,entity,entity_id,payload) VALUES($1,$2,$3,'tenant_role',$4,$5)`,[input.businessId,input.actorId,input.isActive===false?'team.custom_role_archived':'team.custom_role_updated',input.roleId,JSON.stringify({revision,reason:input.reason??null})]);
    await client.query("COMMIT");return revision;
  }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
}
