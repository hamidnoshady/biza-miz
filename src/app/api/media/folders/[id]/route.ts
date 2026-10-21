import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { canMoveFolder, type FolderNode } from "@/lib/media";

/**
 * Rename and/or move (re-parent) one folder.
 *
 * Re-parenting locks all folder rows for this business (`ORDER BY id FOR UPDATE`)
 * inside a transaction and checks both cycle freedom and full subtree depth
 * (`newOwnDepth + maxSubtreeOffset <= MAX_FOLDER_DEPTH`) via `canMoveFolder`
 * (issue #926 P2.8), preventing both deep-subtree overflow and concurrent move
 * races.
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

  let parsedName: string | undefined;
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    parsedName = name;
  }

  let hasParentUpdate = false;
  let newParentId: string | null = null;
  if (body.parentId !== undefined) {
    hasParentUpdate = true;
    if (body.parentId === null || body.parentId === "") {
      newParentId = null;
    } else if (typeof body.parentId === "string") {
      newParentId = body.parentId;
    } else {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }

  if (parsedName === undefined && !hasParentUpdate) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Pure rename with no parent move needs only a single conditional UPDATE.
  if (!hasParentUpdate) {
    const { rows } = await query<{ id: string }>(
      `UPDATE media_folders SET name = $3 WHERE id = $1 AND business_id = $2 RETURNING id`,
      [id, session.businessId, parsedName],
    ).catch(() => ({ rows: [] as { id: string }[] }));
    if (!rows[0]) {
      return NextResponse.json(
        { error: "update_failed", message: "به‌روزرسانی پوشه ممکن نشد؛ شاید نام تکراری باشد." },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.current_business_id', $1, true)`, [session.businessId]);
    const { rows: folderRows } = await client.query<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id
         FROM media_folders
        WHERE business_id = $1
        ORDER BY id
        FOR UPDATE`,
      [session.businessId],
    );
    const nodes: FolderNode[] = folderRows.map((r) => ({ id: r.id, parentId: r.parent_id }));
    const check = canMoveFolder(nodes, id, newParentId);
    if (!check.ok) {
      await client.query("ROLLBACK");
      if (check.error === "folder_not_found" || check.error === "parent_not_found") {
        return NextResponse.json({ error: "folder_not_found" }, { status: 404 });
      }
      if (check.error === "folder_cycle") {
        return NextResponse.json(
          { error: "circular_move", message: "نمی‌توان پوشه را داخل خودش یا زیرمجموعه‌اش جابه‌جا کرد." },
          { status: 400 },
        );
      }
      return NextResponse.json(
        { error: "too_deep", message: "عمق زیرپوشه‌ها پس از جابه‌جایی از سقف مجاز فراتر می‌رود." },
        { status: 400 },
      );
    }

    const fields: string[] = [];
    const values: unknown[] = [id, session.businessId];
    let idx = 2;
    if (parsedName !== undefined) {
      values.push(parsedName);
      fields.push(`name = $${++idx}`);
    }
    values.push(newParentId);
    fields.push(`parent_id = $${++idx}`);

    const { rows } = await client
      .query<{ id: string }>(
        `UPDATE media_folders SET ${fields.join(", ")} WHERE id = $1 AND business_id = $2 RETURNING id`,
        values,
      )
      .catch(() => ({ rows: [] as { id: string }[] }));
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "update_failed", message: "به‌روزرسانی پوشه ممکن نشد؛ شاید نام تکراری باشد." },
        { status: 409 },
      );
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
