import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listCmsPages } from "@/lib/cms/website-service";

function statusFor(error: string): number {
  if (error === "not_found") return 404;
  if (error === "forbidden") return 403;
  if (error === "not_connected") return 409;
  if (error === "cms_unreachable") return 503;
  return 400;
}

/**
 * `GET /api/cms/website/pages` — the site's pages, drafts included. Pages are
 * read-only here: the CMS refuses a page write from a site key (the block
 * layout is a CMS-admin surface), so this app lists them and publishes a draft
 * through `pages/[id]/publish`, nothing more.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
  const page = Number(request.nextUrl.searchParams.get("page") ?? 1);
  const result = await listCmsPages(session.businessId, { limit, page });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ pages: result.data.pages, totalDocs: result.data.totalDocs });
});
