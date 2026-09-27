import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deleteCmsMedia, updateCmsMediaAlt } from "@/lib/cms/website-service";

function statusFor(error: string): number {
  if (error === "not_found") return 404;
  if (error === "forbidden") return 403;
  if (error === "not_connected") return 409;
  if (error === "cms_unreachable") return 503;
  return 400;
}

export const PATCH = withTenantScope(async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;
  const { id } = await ctx.params;
  let body: { alt?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.alt !== "string") return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const result = await updateCmsMediaAlt(session.businessId, id, body.alt);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ media: result.data });
});

export const DELETE = withTenantScope(async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;
  const { id } = await ctx.params;
  const force = request.nextUrl.searchParams.get("force") === "1";
  const result = await deleteCmsMedia(session.businessId, id);
  if (!result.ok) {
    if (!force && result.error === "cms_error") {
      return NextResponse.json(
        { error: "media_in_use", message: "این فایل ممکن است در صفحه یا محصولی استفاده شده باشد." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  }
  return NextResponse.json({ deleted: true });
});
