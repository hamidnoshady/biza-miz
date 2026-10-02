import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "@/lib/auth";
import { getPool, withoutTenantScope } from "@/lib/db";
import { hashCompanyHandoff } from "@/lib/platform-company";
import { hostRoutingEnabled, parseHost, preferredProto, requestHost, rootDomain } from "@/lib/host";

/** Redeem permanent company-staff access on the tenant origin. Not impersonation. */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 400 });
  const parsed = hostRoutingEnabled() ? parseHost(requestHost(request.headers), rootDomain()) : null;
  if (parsed && parsed.kind !== "business") return NextResponse.json({ error: "wrong_origin" }, { status: 400 });

  const result = await withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{
        id: string; platform_admin_id: string; business_id: string; user_id: string; return_path: string;
        subdomain: string; slug: string; full_name: string; role: Role; location_id: string | null;
        platform_user_id: string | null; token_version: number | null;
      }>(
        `SELECT h.id,h.platform_admin_id,h.business_id,h.user_id,h.return_path,
                b.subdomain::text,b.slug::text,u.full_name,u.role,u.location_id,
                u.platform_user_id,pu.token_version
           FROM platform_company_handoffs h
           JOIN platform_company_members m ON m.platform_admin_id=h.platform_admin_id
             AND m.business_id=h.business_id AND m.user_id=h.user_id AND m.is_active
           JOIN platform_admins pa ON pa.id=h.platform_admin_id AND pa.is_active
           JOIN businesses b ON b.id=h.business_id AND b.ownership_kind='platform_internal' AND b.status='active'
           JOIN users u ON u.id=h.user_id AND u.business_id=h.business_id AND u.is_active
           LEFT JOIN platform_users pu ON pu.id=u.platform_user_id
          WHERE h.token_hash=$1 AND h.used_at IS NULL AND h.expires_at>now()
          FOR UPDATE OF h`,
        [hashCompanyHandoff(token)],
      );
      const row = rows[0];
      if (!row || (parsed?.kind === "business" && parsed.label !== row.subdomain)) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(`UPDATE platform_company_handoffs SET used_at=now() WHERE id=$1`, [row.id]);
      await client.query("COMMIT");
      return row;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
  if (!result) return NextResponse.json({ error: "invalid_or_expired" }, { status: 400 });

  const session = await signSession({
    sub: result.user_id,
    role: result.role,
    businessId: result.business_id,
    businessSlug: result.slug,
    businessSubdomain: result.subdomain,
    locationId: result.location_id,
    fullName: result.full_name,
    platformUserId: result.platform_user_id,
    tokenVersion: result.token_version ?? undefined,
  });
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = preferredProto(request.headers.get("x-forwarded-proto"), request.nextUrl.protocol);
  const response = NextResponse.redirect(`${proto}://${host}${result.return_path}`);
  response.cookies.set(SESSION_COOKIE, session, sessionCookieOptions());
  return response;
}
