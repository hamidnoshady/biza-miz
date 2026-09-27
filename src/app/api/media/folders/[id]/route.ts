import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { folderDepthOf, folderMoveCreatesCycle, MAX_FOLDER_DEPTH } from "@/lib/media";
import { listMediaFolders } from "@/lib/media-service";

/**
 * Rename and/or move (re-parent) one folder. Assets in a deleted folder fall
 * back to the root (FK SET NULL) — see DELETE below.
 *
 * A move is the one operation that can corrupt the tree if unchecked: pure
 * `folderMoveCreatesCycle`/`folderDepthOf` (src/lib/media.ts) refuse
 * self-parenting, parenting under one's own descendant, and a resulting
 * depth beyond `MAX_FOLDER_DEPTH` — the same ceiling `POST /folders` already
 * enforces at creation.
 */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
  if (error) return error;
  const { id } = await context.params;

  let body: { name?: unknown; parentId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const fields: string[] = [];
  const values: unknown[] = [id, session.businessId];
  let i = 2;

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    values.push(name);
    fields.push(`name = $${++i}`);
  }

  if (body.parentId !== undefined) {
    const folders = await listMediaFolders(session.businessId);
    if (!folders.some((f) => f.id === id)) {
      return NextResponse.json({ error: "folder_not_found" }, { status: 404 });
    }
    let newParentId: string | null;
    if (body.parentId === null || body.parentId === "") {
      newParentId = null;
    } else if (typeof body.parentId === "string") {
      newParentId = body.parentId;
    } else {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (newParentId !== null && !folders.some((f) => f.id === newParentId)) {
      return NextResponse.json({ error: "folder_not_found" }, { status: 404 });
    }
    const nodes = folders.map((f) => ({ id: f.id, parentId: f.parentId }));
    if (folderMoveCreatesCycle(nodes, id, newParentId)) {
      return NextResponse.json(
        { error: "circular_move", message: "نمی‌توان پوشه را داخل خودش یا زیرمجموعه‌اش جابه‌جا کرد." },
        { status: 400 },
      );
    }
    if (newParentId !== null && folderDepthOf(nodes, newParentId) >= MAX_FOLDER_DEPTH) {
      return NextResponse.json(
        { error: "too_deep", message: "عمق پوشه‌ها بیش از حد مجاز است." },
        { status: 400 },
      );
    }
    values.push(newParentId);
    fields.push(`parent_id = $${++i}`);
  }

  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const { rows } = await query<{ id: string }>(
    `UPDATE media_folders SET ${fields.join(", ")} WHERE id = $1 AND business_id = $2 RETURNING id`,
    values,
  ).catch(() => ({ rows: [] as { id: string }[] }));
  if (!rows[0]) {
    return NextResponse.json(
      { error: "update_failed", message: "به‌روزرسانی پوشه ممکن نشد؛ شاید نام تکراری باشد." },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
  if (error) return error;
  const { id } = await context.params;

  const { rows } = await query<{ id: string }>(
    `DELETE FROM media_folders WHERE id = $1 AND business_id = $2 RETURNING id`,
    [id, session.businessId],
  );
  if (!rows[0]) return NextResponse.json({ error: "folder_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
