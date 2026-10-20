import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { parseCategory, parseTags } from "@/lib/media";
import { workspaceAccessFlags } from "@/lib/workspace-shared";
import {
  deleteMediaAsset,
  getMediaAsset,
  getMediaAssetUsage,
  getMediaConfig,
  MediaAssetProtectedError,
  mediaAssetUsageIsEmpty,
  mediaAssetUsageIsProtected,
  softDeleteMediaAsset,
} from "@/lib/media-service";

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaView);
  if (error) return error;
  const { id } = await context.params;

  const [asset, config] = await Promise.all([
    getMediaAsset(session.businessId, id),
    getMediaConfig(),
  ]);
  if (!asset) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  return NextResponse.json({
    asset,
    enhancePriceRial: config.enhancePriceRial,
  });
});

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaManage);
  if (error) return error;
  const { id } = await context.params;

  const asset = await getMediaAsset(session.businessId, id);
  if (!asset) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  let body: {
    fileName?: unknown;
    folderId?: unknown;
    category?: unknown;
    tags?: unknown;
    aiDecision?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const fields: string[] = [];
  const values: unknown[] = [id, session.businessId];
  let i = 2;
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = $${++i}`);
    values.push(val);
  };

  if (body.fileName !== undefined) {
    const name = typeof body.fileName === "string" ? body.fileName.trim().slice(0, 200) : "";
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    set("file_name", name);
  }

  if (body.folderId !== undefined) {
    if (body.folderId === null || body.folderId === "") {
      set("folder_id", null);
    } else if (typeof body.folderId === "string") {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM media_folders WHERE id = $1 AND business_id = $2`,
        [body.folderId, session.businessId],
      );
      if (!rows[0]) return NextResponse.json({ error: "folder_not_found" }, { status: 404 });
      set("folder_id", body.folderId);
    } else {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }

  const decision = body.aiDecision;
  if (decision !== undefined && decision !== "confirm" && decision !== "reject") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  let category = parseCategory(body.category);
  if (category === undefined && body.category !== undefined) {
    return NextResponse.json({ error: "invalid_category" }, { status: 400 });
  }
  let tags = body.tags !== undefined ? parseTags(body.tags) : undefined;
  if (tags === null) return NextResponse.json({ error: "invalid_tags" }, { status: 400 });

  if (decision === "confirm") {
    const proposal = asset.aiLabels as { category?: unknown; tags?: unknown };
    if (body.category === undefined) {
      category = typeof proposal.category === "string" && proposal.category ? proposal.category : asset.category;
    }
    if (tags === undefined) {
      const proposed = Array.isArray(proposal.tags) ? proposal.tags.filter((t): t is string => typeof t === "string") : [];
      tags = [...new Set([...asset.tags, ...proposed])];
    }
    set("ai_status", "confirmed");
  } else if (decision === "reject") {
    set("ai_status", "rejected");
  }

  if (body.category !== undefined || decision === "confirm") set("category", category ?? null);
  if (tags !== undefined) set("tags", tags);

  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  fields.push("updated_at = now()");

  await query(
    `UPDATE media_assets SET ${fields.join(", ")} WHERE id = $1 AND business_id = $2`,
    values,
  );
  const updated = await getMediaAsset(session.businessId, id);
  return NextResponse.json({ asset: updated });
});

export const DELETE = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.mediaManage);
  if (error) return error;
  const { id } = await context.params;

  const viewerOverride = Boolean(workspaceAccessFlags(membership.permissions).override);

  const force = request.nextUrl.searchParams.get("force") === "1";
  const purge = request.nextUrl.searchParams.get("purge") === "1";

  // Always inspect usage so protected audit records (approved/versioned/contract/
  // journal/AEC Workspace documents, posted financial transfers) are NEVER deleted
  // or purged even when `?force=1` or `?purge=1` is supplied (issue #926 P0.4).
  const usage = await getMediaAssetUsage(id, {
    viewerUserId: session.sub,
    viewerOverride,
  });

  if (mediaAssetUsageIsProtected(usage)) {
    const firstMessage =
      usage.protectedItems?.[0]?.message ??
      "این فایل به رکورد محافظت‌شده متصل است و قابل حذف نیست.";
    return NextResponse.json(
      {
        error: "asset_protected",
        message: firstMessage,
        usage,
        protectedItems: usage.protectedItems ?? [],
      },
      { status: 409 },
    );
  }

  if (!force && !purge && !mediaAssetUsageIsEmpty(usage)) {
    return NextResponse.json({ error: "asset_in_use", usage }, { status: 409 });
  }

  if (purge) {
    const asset = await getMediaAsset(session.businessId, id);
    if (!asset) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
    if (!asset.deletedAt) {
      return NextResponse.json(
        { error: "not_in_trash", message: "برای حذف همیشگی، ابتدا باید مورد در سطل زباله باشد." },
        { status: 409 },
      );
    }
    const config = await getMediaConfig();
    try {
      const deleted = await deleteMediaAsset(session.businessId, id, config);
      if (!deleted) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
    } catch (err) {
      if (err instanceof MediaAssetProtectedError) {
        return NextResponse.json(
          {
            error: "asset_protected",
            message: err.usage.protectedItems?.[0]?.message ?? "این فایل به رکورد محافظت‌شده متصل است.",
            usage: err.usage,
            protectedItems: err.usage.protectedItems ?? [],
          },
          { status: 409 },
        );
      }
      throw err;
    }
    return NextResponse.json({ ok: true, purged: true });
  }

  const trashed = await softDeleteMediaAsset(session.businessId, id);
  if (!trashed) {
    const asset = await getMediaAsset(session.businessId, id);
    if (!asset) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, trashed: true });
});
