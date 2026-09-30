import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deleteCmsPost } from "@/lib/cms/website-service";

function statusFor(error: string): number {
  if (error === "not_found") return 404;
  if (error === "forbidden") return 403;
  if (error === "not_connected") return 409;
  if (error === "cms_unreachable") return 503;
  return 400;
}

// Creating and editing a post go through `/api/cms/website/drafts` (the
// `website.post.draft`/`update` actions, shared with the assistant); this route
// only removes one.
/** `DELETE /api/cms/website/posts/[id]` — remove a post from the connected CMS site. */
export const DELETE = withTenantScope(async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;

  const { id } = await ctx.params;
  const result = await deleteCmsPost(session.businessId, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ deleted: true });
});
