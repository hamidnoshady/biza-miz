import { createHash } from "node:crypto";
import { query } from "./db";
import { cmsMediaPreview } from "./cms/website-service";
import { PERMISSIONS } from "./permissions";
import type { ChatAttachment } from "./ai-service";
import { effectiveAppAvailability } from "./app-availability-service";
import { isAppUsable } from "./app-availability";

/** A client source reference grants nothing: recheck custody and byte identity. */
export async function verifyLibraryAttachments(
  businessId: string, permissions: ReadonlySet<string>, attachments: ChatAttachment[],
): Promise<boolean> {
  if (attachments.some((attachment) => attachment.source && attachment.source.library !== "media") &&
    !isAppUsable(await effectiveAppAvailability(businessId), "website")) return false;
  for (const attachment of attachments) {
    const source = attachment.source;
    if (!source) continue;
    if (attachment.kind !== "image" || !attachment.dataUrl) return false;
    const sha = createHash("sha256").update(Buffer.from(attachment.dataUrl.split(",")[1], "base64")).digest("hex");
    if (source.library === "cms") {
      if (!permissions.has(PERMISSIONS.cmsView)) return false;
      const preview = await cmsMediaPreview(businessId, source.id);
      if (!preview.ok || createHash("sha256").update(new Uint8Array(preview.data.body)).digest("hex") !== sha) return false;
      continue;
    }
    if (!permissions.has(PERMISSIONS.mediaView) ||
      (source.library === "wordpress" && !permissions.has(PERMISSIONS.woocommerceView))) return false;
    const wordpress = source.library === "wordpress";
    const { rows } = await query<{ sha256: string }>(
      `SELECT m.sha256 FROM media_assets m
       ${wordpress ? `JOIN wordpress_media_mapping w ON w.media_asset_id = m.id AND w.business_id = m.business_id
         JOIN integration_connections c ON c.id = w.connection_id AND c.business_id = w.business_id` : ""}
       WHERE m.business_id = $1 AND m.id = $2 AND m.deleted_at IS NULL AND m.kind = 'image'
         AND m.mime_type IN ('image/jpeg','image/png','image/webp') AND m.byte_size <= 5242880
       ${wordpress ? `AND w.connection_id = $3 AND w.wp_media_id = $4 AND w.status = 'synced'
         AND c.provider = 'woocommerce' AND c.status <> 'paused' AND c.last_media_sync_at IS NOT NULL` : ""}`,
      wordpress ? [businessId, source.id, source.connectionId, source.remoteId] : [businessId, source.id],
    );
    if (!rows[0] || rows[0].sha256 !== sha) return false;
  }
  return true;
}
