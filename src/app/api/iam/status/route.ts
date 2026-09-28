import { NextRequest, NextResponse } from "next/server";
import { authenticateIamSite } from "@/lib/iam/site-auth";
import { query, withTenant } from "@/lib/db";

export async function GET(request: NextRequest) {
  const site = await authenticateIamSite(request);
  if (!site) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { rows } = await withTenant(site.businessId, () => query(
    `SELECT last_sequence,last_snapshot_version,last_snapshot_hash,last_attempt_at,last_success_at,status,last_error
       FROM iam_sync_state WHERE business_id=$1 AND site_device_id=$2`, [site.businessId, site.siteDeviceId]));
  return NextResponse.json({ status: rows[0] ?? { last_sequence: 0, status: "snapshot_required" } });
}
