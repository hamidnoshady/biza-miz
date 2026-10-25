import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { listCmsMedia } from "@/lib/cms/website-service";

type LibraryKey = "media" | "cms" | "wordpress";
const allowedMimes = new Set(["image/jpeg", "image/png", "image/webp"]);
const display = { media: "رسانه پلتفرم", cms: "رسانه وب‌سایت Eshobe", wordpress: "رسانه وردپرس" };

interface LibraryItem {
  id: string;
  name: string;
  mimeType: string;
  url: string;
  source: LibraryKey;
  connectionId?: string;
  /** Remote identifier, never a URL accepted from the browser. */
  remoteId?: string;
}
type MappedAsset = { id: string; file_name: string; mime_type: string; byte_size: string; connection_id: string; wp_media_id: string };

async function wordpressItems(businessId: string): Promise<LibraryItem[]> {
  // Only canonical, synced WP mirrors. Never fetch arbitrary WordPress URLs:
  // the canonical asset already has tenant-bound S3 custody and an authenticated file endpoint.
  const { rows } = await query<MappedAsset>(
    `SELECT DISTINCT ON (m.id) m.id, m.file_name, m.mime_type, m.byte_size::text, w.connection_id, w.wp_media_id
       FROM wordpress_media_mapping w
       JOIN media_assets m ON m.business_id = w.business_id AND m.id = w.media_asset_id
       JOIN integration_connections c ON c.business_id = w.business_id AND c.id = w.connection_id
      WHERE w.business_id = $1 AND w.status = 'synced' AND w.wp_media_id IS NOT NULL
        AND c.provider = 'woocommerce' AND c.status <> 'paused' AND c.last_media_sync_at IS NOT NULL
        AND m.deleted_at IS NULL AND m.kind = 'image'
        AND m.mime_type IN ('image/jpeg','image/png','image/webp')
        AND m.byte_size <= 5242880
      ORDER BY m.id, w.synced_at DESC LIMIT 48`,
    [businessId],
  );
  return rows.map((row) => ({
    id: row.id, name: row.file_name, mimeType: row.mime_type,
    url: `/api/media/${row.id}/file`, source: "wordpress" as const,
    connectionId: row.connection_id, remoteId: row.wp_media_id,
  }));
}

async function cmsItems(businessId: string): Promise<LibraryItem[]> {
  const result = await listCmsMedia(businessId, { limit: 48, page: 1 });
  if (!result.ok) return [];
  return result.data.media.filter((file) => allowedMimes.has(file.mimeType ?? "") &&
    (file.filesize == null || file.filesize <= 5242880) &&
    /^[A-Za-z0-9_-]{1,64}$/.test(file.id))
    .map((file) => ({
      id: file.id, name: file.filename?.slice(0, 200) || `CMS ${file.id}`,
      mimeType: file.mimeType!, source: "cms" as const,
      // Existing site-key-authenticated, sandboxed, raster-only proxy.
      url: `/api/cms/website/media/${encodeURIComponent(file.id)}/preview`,
      remoteId: file.id,
    }));
}

/** Only currently authorized, configured, synced image libraries are offered. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const businessId = guard.session.businessId;
  const rights = guard.membership.permissions;
  const kind = request.nextUrl.searchParams.get("source");
  if (kind && !["media", "cms", "wordpress"].includes(kind)) {
    return NextResponse.json({ error: "invalid_source" }, { status: 400 });
  }
  const canMedia = rights.has(PERMISSIONS.mediaView);
  const canCms = rights.has(PERMISSIONS.cmsView);
  const canWp = canMedia && rights.has(PERMISSIONS.woocommerceView);

  if (kind === "media") return NextResponse.json({ items: [], source: "media" });
  if (kind === "cms" && !canCms || kind === "wordpress" && !canWp) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [cms, wordpress] = await Promise.all([
    canCms && (kind == null || kind === "cms") ? cmsItems(businessId) : Promise.resolve([]),
    canWp && (kind == null || kind === "wordpress") ? wordpressItems(businessId) : Promise.resolve([]),
  ]);
  if (kind) return NextResponse.json({ source: kind, items: kind === "cms" ? cms : wordpress });

  const sources: { key: LibraryKey; label: string }[] = [];
  if (canMedia) sources.push({ key: "media", label: display.media });
  if (cms.length) sources.push({ key: "cms", label: display.cms });
  if (wordpress.length) sources.push({ key: "wordpress", label: display.wordpress });
  return NextResponse.json({ sources });
});
