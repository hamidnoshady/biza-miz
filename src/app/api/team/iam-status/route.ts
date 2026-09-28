import { NextRequest,NextResponse } from "next/server";
import { requirePermission,withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { getSetting,SETTING_KEYS } from "@/lib/settings";
import type { ServerSyncConfig } from "@/lib/server-sync-config";
import { runIamSync } from "@/lib/iam/sync";

export const GET=withTenantScope(async()=>{const guard=await requirePermission(PERMISSIONS.teamView);if(guard.error)return guard.error;const config=await getSetting<ServerSyncConfig>(guard.session.businessId,SETTING_KEYS.serverSyncConfig);
 const {rows}=await query<{last_sequence:string;last_attempt_at:Date|null;last_success_at:Date|null;status:string;last_error:string|null;pending:string;failed:string}>(`SELECT s.last_sequence,s.last_attempt_at,s.last_success_at,s.status,s.last_error,
 (SELECT count(*) FROM iam_commands c WHERE c.business_id=s.business_id AND c.site_device_id=s.site_device_id AND c.status='pending')::text pending,
 (SELECT count(*) FROM iam_dead_letters d WHERE d.business_id=s.business_id AND d.site_device_id=s.site_device_id AND d.status='open')::text failed
 FROM iam_sync_state s WHERE s.business_id=$1 AND s.site_device_id=$2`,[guard.session.businessId,config?.siteDeviceId??null]);const row=rows[0];return NextResponse.json({status:row?{sequence:Number(row.last_sequence),state:row.status,lastAttemptAt:row.last_attempt_at?.toISOString()??null,lastSuccessAt:row.last_success_at?.toISOString()??null,lastError:row.last_error,pending:Number(row.pending),failed:Number(row.failed)}:{state:"snapshot_required",sequence:0,pending:0,failed:0}});});
export const POST=withTenantScope(async(request:NextRequest)=>{const guard=await requirePermission(PERMISSIONS.teamManage);if(guard.error)return guard.error;const body=await request.json().catch(()=>({})) as {action?:string};const config=await getSetting<ServerSyncConfig>(guard.session.businessId,SETTING_KEYS.serverSyncConfig);if(!config?.siteDeviceId)return NextResponse.json({error:"site_not_configured"},{status:409});
 if(body.action==="repair")await query(`UPDATE iam_sync_state SET status='snapshot_required',last_error='manual_snapshot_repair' WHERE business_id=$1 AND site_device_id=$2`,[guard.session.businessId,config.siteDeviceId]);
 if(!["sync","repair","retry"].includes(body.action??""))return NextResponse.json({error:"bad_request"},{status:400});const ok=await runIamSync(guard.session.businessId);return NextResponse.json({ok},{status:ok?200:503});});
