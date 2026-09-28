import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { restrictSiteMember, SitePolicyError } from "@/lib/iam/site-policy";

async function patch(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const guard=await requirePermission(PERMISSIONS.teamManage);
  if (guard.error) return guard.error;
  const body=await request.json().catch(()=>null) as null | { permissionDenies?:string[];allowedLocationIds?:string[]|null;
    isLocallySuspended?:boolean;localLoginLocked?:boolean;reason?:string };
  if (!body) return NextResponse.json({error:"bad_request"},{status:400});
  try {
    await restrictSiteMember({businessId:guard.session.businessId,userId:(await context.params).id,actorId:guard.session.sub,...body});
    return NextResponse.json({ok:true,scope:"site_only"});
  } catch (error) {
    if (error instanceof SitePolicyError) return NextResponse.json({error:error.code},{status:error.status});
    throw error;
  }
}
export const PATCH=withTenantScope(patch);
