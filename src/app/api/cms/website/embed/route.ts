import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createCmsEmbedSession } from "@/lib/cms/website-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusFor(error: string): number {
  if (error === "not_found") return 404;
  if (error === "not_connected") return 409;
  if (error === "cms_not_configured") return 503;
  if (error === "cms_unreachable") return 503;
  if (error === "cms_old_version") return 502;
  return 400;
}

/**
 * `POST /api/cms/website/embed` — the CMS edit modal's entry URL.
 *
 * Body `{ collection: "posts" | "pages", id? }`; no `id` opens the «new» form. The reply is
 * `{ url }` — a one-time address on the CMS that signs the iframe into the CMS admin as this
 * business's own site and nothing else. The platform key stays on the server.
 *
 * `canPublish` is derived here from the session's own permissions and never read from the
 * body: it chooses which CMS-side user the modal acts as, and therefore whether the modal
 * shows a Publish button at all.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;

  let body: { collection?: unknown; id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const collection = body.collection;
  if (collection !== "posts" && collection !== "pages") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  let id: string | undefined;
  if (body.id !== undefined && body.id !== null && body.id !== "") {
    if (typeof body.id !== "string" || !UUID.test(body.id)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    id = body.id;
  }

  const result = await createCmsEmbedSession(session.businessId, {
    collection,
    id,
    canPublish: membership.permissions.has(PERMISSIONS.cmsPublish),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ url: result.data.url }, { headers: { "Cache-Control": "no-store" } });
});
