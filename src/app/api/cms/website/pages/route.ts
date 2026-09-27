import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createCmsPage, listCmsPages } from "@/lib/cms/website-service";

function statusFor(error: string): number {
  if (error === "not_found") return 404;
  if (error === "forbidden") return 403;
  if (error === "not_connected") return 409;
  if (error === "cms_unreachable") return 503;
  return 400;
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
  const page = Number(request.nextUrl.searchParams.get("page") ?? 1);
  const result = await listCmsPages(session.businessId, { limit, page });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ pages: result.data.pages, totalDocs: result.data.totalDocs });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;
  let body: { title?: string; slug?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await createCmsPage(session.businessId, {
    title: typeof body.title === "string" ? body.title : "",
    slug: typeof body.slug === "string" ? body.slug : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ page: result.data }, { status: 201 });
});
