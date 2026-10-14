import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { platformCompanyLog, withPlatformCompany } from "@/lib/platform-company";
import { platformAudit, withPlatformScope } from "@/lib/platform-auth";
import { isUuid } from "@/lib/uuid";
import type { SiteCredentialSummary } from "@/lib/platform-company-types";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const PROVIDERS = ["eshobe", "wordpress"] as const;
type Provider = (typeof PROVIDERS)[number];

/**
 * Site-scoped, show-once credentials for public lead forms.
 *
 * A credential is bound to ONE site record of ONE provider. It grants exactly
 * one capability — submitting a lead for that site — and no tenant read access
 * at all: the intake route resolves the credential, then writes under the
 * internal company's own tenant scope.
 *
 * The raw token is returned once, at creation, and only its hash is stored.
 * Rotation (POST again for the same site/provider) replaces the hash and
 * deactivates nothing else; revocation sets `is_active = false` and stamps
 * `revoked_at`, so a revoked credential fails closed on the next request.
 */
export const GET = withPlatformScope(async (): Promise<NextResponse> => {
  const result = await withPlatformCompany(PERMISSIONS.websiteManage, async (actor) => {
    const { rows } = await query<{
      id: string; site_key: string; site_id: string | null; provider: Provider;
      is_active: boolean; revoked_at: Date | null; requests_per_minute: number;
      last_used_at: Date | null; created_at: Date;
    }>(
      `SELECT id, site_key, site_id, provider, is_active, revoked_at,
              requests_per_minute, last_used_at, created_at
         FROM platform_company_site_credentials
        WHERE business_id = $1
        ORDER BY site_key, provider`,
      [actor.businessId],
    );
    const credentials: SiteCredentialSummary[] = rows.map((row) => ({
      id: row.id,
      siteKey: row.site_key,
      siteId: row.site_id,
      provider: row.provider,
      isActive: row.is_active,
      revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
      requestsPerMinute: row.requests_per_minute,
      lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
    }));
    return credentials;
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ credentials: result.value });
});

export const POST = withPlatformScope(async (request: NextRequest): Promise<NextResponse> => {
  let body: { siteKey?: string; provider?: string; requestsPerMinute?: number; siteId?: string | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const siteKey = body.siteKey?.trim();
  const provider = body.provider;
  const rpm = Math.floor(body.requestsPerMinute ?? 30);
  const siteId = body.siteId?.trim() || null;
  if (
    !siteKey ||
    siteKey.length > 100 ||
    !PROVIDERS.includes(provider as Provider) ||
    rpm < 1 ||
    rpm > 300 ||
    (siteId !== null && !isUuid(siteId))
  ) {
    return NextResponse.json({ error: "invalid_credential" }, { status: 400 });
  }
  const token = `pcf_${randomBytes(32).toString("base64url")}`;
  const result = await withPlatformCompany(PERMISSIONS.websiteManage, async (actor) => {
    // The site must be a real site record of this business and of the chosen
    // provider. Without this check `site_id` would be an unvalidated pointer
    // anywhere in the database.
    if (siteId) {
      const { rows } = await query<{ id: string }>(
        provider === "eshobe"
          ? `SELECT id FROM eshobe_cms_connections WHERE id = $1 AND business_id = $2`
          : `SELECT id FROM integration_connections WHERE id = $1 AND business_id = $2 AND provider = 'woocommerce'`,
        [siteId, actor.businessId],
      );
      if (!rows[0]) throw new Error("site_not_found");
    }
    const { rows } = await query<{
      id: string; site_key: string; provider: Provider; requests_per_minute: number; site_id: string | null;
    }>(
      `INSERT INTO platform_company_site_credentials
         (business_id, site_key, site_id, provider, token_hash, requests_per_minute, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (business_id, site_key, provider) DO UPDATE SET
         token_hash = EXCLUDED.token_hash, site_id = EXCLUDED.site_id,
         requests_per_minute = EXCLUDED.requests_per_minute,
         is_active = true, revoked_at = NULL, window_count = 0,
         window_started_at = now(), created_by = EXCLUDED.created_by
       RETURNING id, site_key, provider, requests_per_minute, site_id`,
      [actor.businessId, siteKey, siteId, provider, digest(token), rpm, actor.userId],
    );
    await platformAudit({
      adminId: actor.platformAdminId,
      businessId: actor.businessId,
      action: "platform_company.website_credential.rotated",
      entity: "platform_company_site_credential",
      entityId: rows[0].id,
      // Never the token, its hash, or any part of either.
      payload: { siteKey, provider, requestsPerMinute: rpm, siteId },
    });
    platformCompanyLog("credential.rotated", {
      businessId: actor.businessId,
      credentialId: rows[0].id,
      provider,
    });
    return rows[0];
  });
  if (!result.ok) {
    const status = result.error === "site_not_found" ? 404 : result.status;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ credential: result.value, token }, { status: 201 });
});

export const DELETE = withPlatformScope(async (request: NextRequest): Promise<NextResponse> => {
  let body: { id?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
  const result = await withPlatformCompany(PERMISSIONS.websiteManage, async (actor) => {
    const { rowCount } = await query(
      `UPDATE platform_company_site_credentials
          SET is_active = false, revoked_at = now()
        WHERE id = $1 AND business_id = $2`,
      [body.id, actor.businessId],
    );
    if (rowCount === 1) {
      await platformAudit({
        adminId: actor.platformAdminId,
        businessId: actor.businessId,
        action: "platform_company.website_credential.revoked",
        entity: "platform_company_site_credential",
        entityId: body.id!,
      });
      platformCompanyLog("credential.revoked", {
        businessId: actor.businessId,
        credentialId: body.id,
      });
    }
    return rowCount === 1;
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  if (!result.value) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
