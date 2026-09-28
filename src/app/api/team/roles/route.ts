import { NextRequest,NextResponse } from "next/server";
import { requirePermission,withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createTenantRole,listTenantRoles,TenantRoleError } from "@/lib/iam/roles-service";
import { isLocationScope } from "@/lib/location-access";

export const GET=withTenantScope(async()=>{const guard=await requirePermission(PERMISSIONS.teamView);if(guard.error)return guard.error;
  return NextResponse.json({roles:await listTenantRoles(guard.session.businessId)});});
export const POST=withTenantScope(async(request:NextRequest)=>{const guard=await requirePermission(PERMISSIONS.teamPermissionsManage);if(guard.error)return guard.error;
  const body=await request.json().catch(()=>null) as null|{name?:string;description?:string;permissions?:unknown;defaultLocationScope?:string;reason?:string};if(!body?.name)return NextResponse.json({error:"bad_request"},{status:400});
  if(body.defaultLocationScope!==undefined&&!isLocationScope(body.defaultLocationScope))return NextResponse.json({error:"invalid_location_scope"},{status:400});
  try{const id=await createTenantRole({businessId:guard.session.businessId,actorId:guard.session.sub,name:body.name,description:body.description,permissions:body.permissions??[],defaultLocationScope:body.defaultLocationScope,reason:body.reason});return NextResponse.json({id},{status:201});}
  catch(e){if(e instanceof TenantRoleError)return NextResponse.json({error:e.code},{status:e.status});throw e;}});
