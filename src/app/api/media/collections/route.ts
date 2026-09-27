import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { MAX_COLLECTION_DESCRIPTION_LENGTH, MAX_COLLECTION_NAME_LENGTH } from "@/lib/media";
import { createMediaCollection, listMediaCollections } from "@/lib/media-service";

/**
 * Collections — a named, ad hoc set of assets, distinct from a folder (one
 * tree slot per asset) and from a tag (a free-text label): a collection is a
 * first-class, renamable, listable object with its own membership, e.g. "همه
 * برای کمپین تابستانه". An asset can belong to any number of collections.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaView);
  if (error) return error;
  const collections = await listMediaCollections(session.businessId);
  return NextResponse.json({ collections });
});

export const POST = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
  if (error) return error;

  let body: { name?: unknown; description?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_COLLECTION_NAME_LENGTH) : "";
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  const description =
    typeof body.description === "string" && body.description.trim()
      ? body.description.trim().slice(0, MAX_COLLECTION_DESCRIPTION_LENGTH)
      : null;

  try {
    const collection = await createMediaCollection(session.businessId, session.sub, name, description);
    return NextResponse.json({ collection }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("unique") || message.includes("duplicate")) {
      return NextResponse.json({ error: "name_taken" }, { status: 409 });
    }
    throw err;
  }
});
