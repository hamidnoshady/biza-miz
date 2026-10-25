import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { cmsMediaPreview } from "@/lib/cms/website-service";

function statusFor(error: string): number {
  if (error === "not_found" || error === "no_preview") return 404;
  if (error === "not_connected") return 409;
  if (error === "cms_unreachable") return 503;
  return 502;
}

/**
 * The media grid's thumbnail. The CMS serves files under its own access rules and needs
 * the site key, which never reaches the browser — so the dashboard relays the bytes.
 * Raster images only (`fetchMediaPreview`), sent with `nosniff` and a sandbox CSP so a
 * relayed file can never run as this app's own page.
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const result = await cmsMediaPreview(session.businessId, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return new NextResponse(result.data.body, {
    headers: {
      "content-type": result.data.contentType,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "content-disposition": "inline",
    },
  });
});
