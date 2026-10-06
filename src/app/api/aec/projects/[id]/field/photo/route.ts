import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  hasMatchingMediaSignature,
  MEDIA_MAX_BYTES,
  mediaKindForMime,
} from "@/lib/media";
import {
  findMediaAssetByHash,
  getMediaConfig,
  isMediaStorageReady,
  storeMediaAsset,
} from "@/lib/media-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError } from "../../../../guard";

/**
 * §25's fast photo capture — one multipart upload straight into the field
 * record, without the back-office Media Library's door.
 *
 * The library's own `POST /api/media` is gated on `media.manage` because the
 * library is custody of the business's brand and document files. A site user
 * photographing a wall does not hold that permission, and §25 is explicit that
 * photo capture has to be *fast* on a phone — so this route is the narrow door:
 * it requires the project write capability (`workspace.manage` intersected with
 * the member's project role), accepts images only, and keeps every rule the
 * library enforces (byte-signature check, per-kind size cap, tenant-scoped
 * duplicate reuse) by calling the same `storeMediaAsset`.
 *
 * The response is the asset id the capture sheet then attaches to the site log
 * or the snag as `{ mediaAssetId }` — the same link shape every register's
 * attachment editor already accepts, so a photo taken here and a file picked in
 * the office land in the register identically.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;

    try {
      await requireProjectCapability(owner, id, "manage");

      const config = await getMediaConfig();
      if (!isMediaStorageReady(config)) {
        return NextResponse.json(
          {
            error: "storage_not_configured",
            message: "فضای ذخیره‌سازی رسانه هنوز پیکربندی نشده است؛ عکس را بعداً از کتابخانهٔ رسانه بفرستید.",
          },
          { status: 503 },
        );
      }

      const form = await request.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "missing_file" }, { status: 400 });

      const kind = mediaKindForMime(file.type);
      if (kind !== "image") {
        return NextResponse.json(
          { error: "unsupported_type", message: "حالت کارگاه فقط عکس می‌پذیرد." },
          { status: 400 },
        );
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MEDIA_MAX_BYTES.image) {
        return NextResponse.json(
          { error: "file_too_large", message: "حجم عکس بیش از سقف مجاز است." },
          { status: 400 },
        );
      }
      if (!hasMatchingMediaSignature(file.type, new Uint8Array(bytes))) {
        return NextResponse.json(
          { error: "signature_mismatch", message: "محتوای فایل با نوع اعلام‌شدهٔ آن نمی‌خواند." },
          { status: 400 },
        );
      }

      const sha256 = createHash("sha256").update(bytes).digest("hex");
      // Identical bytes already in this business's library are reused rather
      // than stored twice — the library's own rule, and the reason a retry
      // after a dropped connection does not leave two copies of one wall.
      const existing = await findMediaAssetByHash(owner.businessId, sha256).catch(() => null);
      if (existing) return NextResponse.json({ asset: existing, duplicate: true });

      const asset = await storeMediaAsset({
        businessId: owner.businessId,
        userId: owner.actorUserId,
        config,
        kind,
        fileName: file.name || "site-photo.jpg",
        mimeType: file.type,
        bytes,
        sha256,
        projectId: id,
      });
      return NextResponse.json({ asset, duplicate: false }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
