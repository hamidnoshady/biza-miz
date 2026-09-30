import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { publishCmsProduct } from "@/lib/cms/website-service";

function statusFor(error: string): number {
  if (error === "not_found") return 404;
  if (error === "forbidden") return 403;
  if (error === "not_connected") return 409;
  if (error === "cms_not_configured") return 503;
  if (error === "cms_unreachable") return 503;
  return 400;
}

/**
 * `POST /api/cms/website/products/[id]/publish` — puts a draft product on the
 * shop. A site key can never publish (the CMS refuses `_status: "published"`
 * on every key-authorized write), so this goes through the platform-key owner
 * bridge like pages and posts, behind `cms.publish` — a person's click.
 */
export const POST = withTenantScope(async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsPublish);
  if (error) return error;
  const { id } = await ctx.params;
  const result = await publishCmsProduct(session.businessId, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ published: result.data });
});
