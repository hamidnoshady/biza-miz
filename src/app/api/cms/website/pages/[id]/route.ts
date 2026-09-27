import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deleteCmsPage, updateCmsPage } from "@/lib/cms/website-service";

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
  let body: { title?: string; slug?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await updateCmsPage(session.businessId, id, {
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.slug === "string" ? { slug: body.slug } : {}),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ page: result.data });
});

export const DELETE = withTenantScope(async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;
  const { id } = await ctx.params;
  const result = await deleteCmsPage(session.businessId, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ deleted: true });
});
