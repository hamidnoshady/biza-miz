import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { withPlatformCompany } from "@/lib/platform-company";
import { platformAudit } from "@/lib/platform-auth";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function GET() {
  const result = await withPlatformCompany(PERMISSIONS.websiteManage, async (actor) => {
    const { rows } = await query(
      `SELECT id,site_key,provider,is_active,requests_per_minute,last_used_at,created_at
         FROM platform_company_site_credentials WHERE business_id=$1 ORDER BY site_key,provider`,
      [actor.businessId],
    );
    return rows;
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ credentials: result.value });
}

export async function POST(request: NextRequest) {
  let body: { siteKey?: string; provider?: string; requestsPerMinute?: number };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  const siteKey = body.siteKey?.trim();
  const provider = body.provider;
  const rpm = Math.floor(body.requestsPerMinute ?? 30);
  if (!siteKey || siteKey.length > 100 || !["eshobe", "wordpress"].includes(provider ?? "") || rpm < 1 || rpm > 300) {
    return NextResponse.json({ error: "invalid_credential" }, { status: 400 });
  }
  const token = `pcf_${randomBytes(32).toString("base64url")}`;
  const result = await withPlatformCompany(PERMISSIONS.websiteManage, async (actor) => {
    const { rows } = await query<{ id: string; site_key: string; provider: string; requests_per_minute: number }>(
      `INSERT INTO platform_company_site_credentials
         (business_id,site_key,provider,token_hash,requests_per_minute,created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (business_id,site_key,provider) DO UPDATE SET
         token_hash=EXCLUDED.token_hash,requests_per_minute=EXCLUDED.requests_per_minute,
         is_active=true,window_count=0,window_started_at=now(),created_by=EXCLUDED.created_by
       RETURNING id,site_key,provider,requests_per_minute`,
      [actor.businessId, siteKey, provider, digest(token), rpm, actor.userId],
    );
    await platformAudit({ adminId: actor.platformAdminId, businessId: actor.businessId,
      action: "platform_company.website_credential.rotated", entity: "platform_company_site_credential",
      entityId: rows[0].id, payload: { siteKey, provider, requestsPerMinute: rpm } });
    return rows[0];
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ credential: result.value, token }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  let body: { id?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  if (!body.id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
  const result = await withPlatformCompany(PERMISSIONS.websiteManage, async (actor) => {
    const { rowCount } = await query(
      `UPDATE platform_company_site_credentials SET is_active=false
        WHERE id=$1 AND business_id=$2`, [body.id, actor.businessId],
    );
    if (rowCount === 1) await platformAudit({ adminId: actor.platformAdminId, businessId: actor.businessId,
      action: "platform_company.website_credential.revoked", entity: "platform_company_site_credential", entityId: body.id });
    return rowCount === 1;
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  if (!result.value) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
