import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { MAX_COLLECTION_DESCRIPTION_LENGTH, MAX_COLLECTION_NAME_LENGTH } from "@/lib/media";
import { deleteMediaCollection, renameMediaCollection } from "@/lib/media-service";

export const PATCH = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
  if (error) return error;
  const { id } = await context.params;

  let body: { name?: unknown; description?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_COLLECTION_NAME_LENGTH) : "";
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  const description =
    body.description === undefined
      ? undefined
      : typeof body.description === "string" && body.description.trim()
        ? body.description.trim().slice(0, MAX_COLLECTION_DESCRIPTION_LENGTH)
        : null;

  const updated = await renameMediaCollection(session.businessId, id, name, description);
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});

/** Deleting a collection only disbands the grouping — its assets are untouched. */
export const DELETE = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
  if (error) return error;
  const { id } = await context.params;

  const deleted = await deleteMediaCollection(session.businessId, id);
  if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
