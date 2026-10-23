import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createCmsEmbedSession } from "@/lib/cms/website-service";
import { isOwnerEmbedCollection, type OwnerEmbedTarget } from "@/lib/cms/embed-targets";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusFor(error: string): number {
  if (error === "not_found") return 404;
  if (error === "not_connected") return 409;
  if (error === "cms_not_configured") return 503;
  if (error === "cms_unreachable") return 503;
  if (error === "cms_old_version") return 502;
  if (error === "cms_site_missing") return 502;
  return 400;
}

/**
 * `POST /api/cms/website/embed` — the CMS edit modal's entry URL.
 *
 * Body `{ view?: "edit" | "list" | "dashboard", collection?, id? }`. `edit` (the default)
 * opens one document, or the «new» form without `id`; `list` opens a collection's list;
 * `dashboard` opens the site's whole admin panel, which is how an owner manages the site
 * without ever leaving this app. `collection` is the CMS's embed allowlist
 * (`OWNER_EMBED_COLLECTIONS`). The reply is `{ url }` — a one-time address on the CMS that signs the iframe into the CMS admin as this
 * business's own site and nothing else. The platform key stays on the server.
 *
 * `canPublish` is derived here from the session's own permissions and never read from the
 * body: it chooses which CMS-side user the modal acts as, and therefore whether the modal
 * shows a Publish button at all.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;

  let body: { collection?: unknown; id?: unknown; view?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const view = body.view ?? "edit";
  let target: OwnerEmbedTarget;
  if (view === "dashboard") {
    target = { view: "dashboard" };
  } else if (view === "list" || view === "edit") {
    const collection = body.collection;
    if (!isOwnerEmbedCollection(collection)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (view === "list") {
      target = { view: "list", collection };
    } else {
      let id: string | undefined;
      if (body.id !== undefined && body.id !== null && body.id !== "") {
        if (typeof body.id !== "string" || !UUID.test(body.id)) {
          return NextResponse.json({ error: "bad_request" }, { status: 400 });
        }
        id = body.id;
      }
      target = { collection, id };
    }
  } else {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await createCmsEmbedSession(session.businessId, {
    ...target,
    canPublish: membership.permissions.has(PERMISSIONS.cmsPublish),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ url: result.data.url }, { headers: { "Cache-Control": "no-store" } });
});
