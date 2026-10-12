import { NextRequest,NextResponse } from "next/server";
import { requirePermission,withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updateTenantRole,TenantRoleError } from "@/lib/iam/roles-service";
import { isLocationScope } from "@/lib/location-access";
export const PATCH=withTenantScope(async(request:NextRequest,context:{params:Promise<{id:string}>})=>{const guard=await requirePermission(PERMISSIONS.teamPermissionsManage);if(guard.error)return guard.error;
 const body=await request.json().catch(()=>null) as null|{expectedRevision?:number;name?:string;description?:string;permissions?:unknown;isActive?:boolean;defaultLocationScope?:string;reason?:string};if(!body||!Number.isSafeInteger(body.expectedRevision))return NextResponse.json({error:"bad_request"},{status:400});
 if(body.defaultLocationScope!==undefined&&!isLocationScope(body.defaultLocationScope))return NextResponse.json({error:"invalid_location_scope"},{status:400});
 try{const revision=await updateTenantRole({businessId:guard.session.businessId,actorId:guard.session.sub,roleId:(await context.params).id,expectedRevision:body.expectedRevision!,name:body.name,description:body.description,permissions:body.permissions,isActive:body.isActive,defaultLocationScope:body.defaultLocationScope,reason:body.reason});return NextResponse.json({ok:true,revision});}
 catch(e){if(e instanceof TenantRoleError)return NextResponse.json({error:e.code},{status:e.status});throw e;}});
