import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requireMember } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getMediaAssetUsage, getMediaConfig, isMediaStorageReady, readMediaObject } from "@/lib/media-service";
import { readMirroredMediaObject } from "@/lib/media-mirror";

/**
 * The object's bytes, served through the app: the browser never talks to the
 * bucket, so the S3 credential stays server-side and the tenant check
 * (`keyBelongsToBusiness`, inside readMediaObject) runs on every read.
 *
 * Images and videos render inline (the library grid's thumbnails and the
 * item pickers); everything else downloads — a "document" that turned out to
 * be active content must never execute on this origin.
 *
 * Two different questions decide access to an INLINE asset, and they are not
 * the same permission:
 *
 *   1. "Can this member browse the Media Library?" — `media.view`, held by
 *      owner/manager/admin.
 *   2. "Can this member render a photo an application record they may
 *      already open is showing them?" — a cashier/waiter/kitchen member
 *      cannot browse the library, but the POS tile, the waiter card and the
 *      kitchen ticket all render a menu item's own photo
 *      (`MenuItemImage` → this route), and an inventory screen renders an
 *      item's own photo the same way; an accountant with `ledger.view` but
 *      not `media.view` can likewise open a recorded expense's receipt photo
 *      (migration 0177), a purchaser with `inventory.view` can open a
 *      draft purchase's own scanned invoice photo (migration 0179), and a
 *      CRM editor with `parties.view` can open a party's own uploaded avatar
 *      (migration 0181). Those roles hold `menu.view` / `inventory.view` /
 *      `ledger.view` / `parties.view`; whether THIS SPECIFIC asset is the
 *      photo of a menu item, inventory item, expense receipt, purchase
 *      invoice, or party avatar they are already authorized to see is what
 *      `getMediaAssetUsage` answers.
 *
 * Neither path ever grants the DOCUMENT kinds this cheaply — a PDF/DOCX read
 * always requires `media.view`, because "used by a catalogue item" is not a
 * concept documents participate in.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, membership, error } = await requireMember();
  if (error) return error;
  const { id } = await context.params;

  const config = await getMediaConfig();
  let result: { asset: { kind: string; fileName: string; mimeType: string }; bytes: Buffer } | null = null;
  try {
    if (isMediaStorageReady(config)) result = await readMediaObject(session.businessId, id, config);
    // A paired site's snapshot carries media metadata, not cloud bucket
    // credentials. Fetch once over its scoped sync credential and keep a
    // checksum-verified local mirror for subsequent Internet outages.
    if (!result) result = await readMirroredMediaObject(session.businessId, id);
  } catch {
    return NextResponse.json({ error: "storage_error" }, { status: 502 });
  }
  if (!result) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  const { asset, bytes } = result;
  const inline = asset.kind === "image" || asset.kind === "video";
  const canBrowseLibrary = membership.permissions.has(PERMISSIONS.mediaView);

  if (!canBrowseLibrary) {
    if (!inline) {
      // Reading a document is a media-library action, never a selling-screen
      // one — no usage exception exists for this kind.
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const usage = await getMediaAssetUsage(id);
    const authorizedByUsage =
      (usage.menuItems.length > 0 && membership.permissions.has(PERMISSIONS.menuView)) ||
      (usage.inventoryItems.length > 0 && membership.permissions.has(PERMISSIONS.inventoryView)) ||
      (usage.expenses.length > 0 && membership.permissions.has(PERMISSIONS.ledgerView)) ||
      (usage.purchases.length > 0 && membership.permissions.has(PERMISSIONS.inventoryView)) ||
      (usage.parties.length > 0 && membership.permissions.has(PERMISSIONS.partiesView));
    if (!authorizedByUsage) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }
  const fileName = encodeURIComponent(asset.fileName);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      // SVG can carry markup; force download for it despite being an "image".
      "Content-Type": asset.mimeType === "image/svg+xml" ? "application/octet-stream" : asset.mimeType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `${inline && asset.mimeType !== "image/svg+xml" ? "inline" : "attachment"}; filename*=UTF-8''${fileName}`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
