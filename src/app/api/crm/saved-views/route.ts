import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  deleteSavedView,
  isSavedViewEntity,
  listSavedViews,
  saveView,
  type SavedViewEntity,
} from "@/lib/crm-saved-views-service";

/**
 * Saved views — «نماهای ذخیره‌شده»: a named set of filters on a list.
 *
 * The service has held the whole rule since migration 0157 — a closed filter
 * vocabulary per entity, validated on write *and* on read; `owner_user_id`
 * checked in SQL so another member's private view cannot leak. Nothing called
 * it, which is why this route exists: the backend was finished and the product
 * surface was not.
 *
 * ## Permissions
 *
 * Reading and saving are `crm.view` and `crm.manage` — day-to-day work, not
 * configuration. A saved view is a *shortcut past the filters*, so it can never
 * see more than the screen it opens: the filters it stores are the same keys
 * the list screen accepts, and the screen's own read gate still decides what
 * the query returns. Writing a view is not a disclosure; the stored document is
 * the member's own typing.
 *
 * ## Why the entity is a query parameter and not a path segment
 *
 * `GET /api/crm/saved-views?entity=deals` reads as "the views for deals",
 * which is the question the screen asks. A path segment
 * (`/api/crm/saved-views/deals`) would read as a resource called «deals» inside
 * «saved views», and there is no such thing — the entity is a filter on the
 * list, which is exactly what the table's CHECK constraint says.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const entity = request.nextUrl.searchParams.get("entity");
  if (!isSavedViewEntity(entity)) {
    return NextResponse.json({ error: "saved_view_entity_invalid" }, { status: 400 });
  }
  const views = await listSavedViews(session.businessId, entity as SavedViewEntity, session.sub);
  return NextResponse.json({ views });
});

interface ViewBody {
  id?: string;
  entity?: string;
  name?: string;
  filters?: unknown;
  shared?: boolean;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmManage);
  if (error) return error;

  let body: ViewBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isSavedViewEntity(body.entity)) {
    return NextResponse.json({ error: "saved_view_entity_invalid" }, { status: 400 });
  }

  const result = await saveView(
    session.businessId,
    {
      id: body.id,
      entity: body.entity as SavedViewEntity,
      name: body.name ?? "",
      filters: body.filters,
      // Explicit, never defaulted: a private view that turns out to be shared
      // exposes how one salesperson works, and a shared view that turns out to
      // be private hides the manager's work from the team they built it for.
      shared: body.shared === true,
    },
    { name: session.fullName, userId: session.sub },
  );
  if (!result.ok) {
    const status =
      result.error === "not_found" ? 404 : result.error === "forbidden" || result.error === "builtin_readonly" ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ view: result.view }, { status: body.id ? 200 : 201 });
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmManage);
  if (error) return error;

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "saved_view_id_required" }, { status: 400 });
  const deleted = await deleteSavedView(session.businessId, id, { userId: session.sub });
  if (!deleted) return NextResponse.json({ error: "saved_view_not_found" }, { status: 404 });
  return NextResponse.json({ result: "deleted" });
});
