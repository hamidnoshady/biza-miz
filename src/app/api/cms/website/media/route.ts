import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listCmsMedia } from "@/lib/cms/website-service";
import { uploadWebsiteMedia, websiteStatusFor } from "@/lib/website/content-service";

function statusFor(error: string): number {
  if (error === "not_connected") return 409;
  if (error === "cms_unreachable") return 503;
  return 400;
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 24);
  const page = Number(request.nextUrl.searchParams.get("page") ?? 1);
  const result = await listCmsMedia(session.businessId, { limit, page });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ media: result.data.media, totalDocs: result.data.totalDocs });
});

/** Upload one featured image through the server; the CMS key never reaches the browser. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing_file" }, { status: 400 });
  const result = await uploadWebsiteMedia({
    businessId: session.businessId,
    filename: file.name,
    mimeType: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
    alt: typeof form?.get("alt") === "string" ? String(form.get("alt")) : undefined,
  });
  if (!result.ok) {
    const status = result.error === "invalid_media" ? 400 : websiteStatusFor(result.error);
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ media: result.data }, { status: 201 });
});
