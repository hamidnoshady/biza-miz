import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requireMember } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { parseHttpByteRange } from "@/lib/media";
import {
  getActiveMediaAssetWithStorageKey,
  getMediaAssetUsage,
  getMediaConfig,
  isMediaStorageReady,
  mediaAssetUsedByVehicleInLocations,
  streamMediaObject,
} from "@/lib/media-service";
import { openMirroredMediaStream } from "@/lib/media-mirror";
import { branchAccessForSession } from "@/lib/automotive-access";

/**
 * Authorize BEFORE touching S3 or local mirror bytes, enforce `deleted_at IS NULL`,
 * and stream full or RFC 9110 byte-range (`206 Partial Content` / `416`) responses
 * directly to the browser without buffering whole files in memory (issue #926 P0.1,
 * P0.2, P1.6).
 */
export const GET = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, membership, error } = await requireMember();
  if (error) return error;
  const { id } = await context.params;

  // 1. Metadata & active-status check ONLY — no S3 read, no mirror read.
  const meta = await getActiveMediaAssetWithStorageKey(session.businessId, id);
  if (!meta) {
    return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
  }

  const { asset, storageKey, sha256 } = meta;
  const inline = asset.kind === "image" || asset.kind === "video";
  const canBrowseLibrary = membership.permissions.has(PERMISSIONS.mediaView);

  // 2. Authorization check BEFORE touching object storage or local mirror.
  if (!canBrowseLibrary) {
    if (!inline) {
      // Document reads strictly require `media.view` — no inline usage exception.
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const usage = await getMediaAssetUsage(id);
    const authorizedByUsage =
      (usage.menuItems.length > 0 && membership.permissions.has(PERMISSIONS.menuView)) ||
      (usage.inventoryItems.length > 0 && membership.permissions.has(PERMISSIONS.inventoryView)) ||
      ((usage.products?.length ?? 0) > 0 && membership.permissions.has(PERMISSIONS.inventoryView)) ||
      (usage.expenses.length > 0 && membership.permissions.has(PERMISSIONS.ledgerView)) ||
      ((usage.transfers?.length ?? 0) > 0 && membership.permissions.has(PERMISSIONS.ledgerView)) ||
      (usage.purchases.length > 0 && membership.permissions.has(PERMISSIONS.inventoryView)) ||
      (usage.parties.length > 0 && membership.permissions.has(PERMISSIONS.partiesView));
    const canViewVehicles = membership.permissions.has(PERMISSIONS.vehiclesView);
    const authorizedByVehicle = canViewVehicles
      ? await (async () => {
          const branchAccess = await branchAccessForSession(session);
          return mediaAssetUsedByVehicleInLocations(id, session.businessId, branchAccess.allowedLocationIds);
        })()
      : false;
    if (!authorizedByUsage && !authorizedByVehicle) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  // 3. Conditional ETag revalidation after auth + active check so soft-deletes
  //    and revoked permissions take effect immediately with zero stale cache leak.
  const etag = `"${sha256}"`;
  const rangeHeader = request.headers.get("range");
  if (!rangeHeader && request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": "private, max-age=0, must-revalidate",
        "Accept-Ranges": "bytes",
      },
    });
  }

  // 4. Parse HTTP Byte Range before opening upstream storage / mirror stream.
  const parsedRange = parseHttpByteRange(rangeHeader, asset.byteSize);
  if (parsedRange.kind === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${asset.byteSize}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  }

  const rangeOption =
    parsedRange.kind === "partial"
      ? { start: parsedRange.start, end: parsedRange.end }
      : undefined;

  // 5. Stream bytes from S3 (when configured) with local checksum-verified mirror fallback.
  const config = await getMediaConfig();
  let streamBody: ReadableStream<Uint8Array> | null = null;
  let contentLength: number =
    parsedRange.kind === "partial" ? parsedRange.contentLength : asset.byteSize;

  try {
    if (isMediaStorageReady(config)) {
      const upstream = await streamMediaObject(session.businessId, storageKey, config, {
        range: rangeOption,
        signal: request.signal,
      });
      if (upstream) {
        streamBody = upstream.stream;
        if (upstream.contentLength !== null) contentLength = upstream.contentLength;
      }
    }
    if (!streamBody) {
      const mirrored = await openMirroredMediaStream(session.businessId, id, {
        range: rangeOption,
        signal: request.signal,
      });
      if (mirrored) {
        streamBody = mirrored.stream;
        contentLength = mirrored.contentLength;
      }
    }
  } catch {
    return NextResponse.json({ error: "storage_error" }, { status: 502 });
  }

  if (!streamBody) {
    return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
  }

  const fileName = encodeURIComponent(asset.fileName);
  const headers: Record<string, string> = {
    "Content-Type": asset.mimeType === "image/svg+xml" ? "application/octet-stream" : asset.mimeType,
    "Content-Length": String(contentLength),
    "Content-Disposition": `${inline && asset.mimeType !== "image/svg+xml" ? "inline" : "attachment"}; filename*=UTF-8''${fileName}`,
    "Cache-Control": "private, max-age=0, must-revalidate",
    ETag: etag,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  };
  if (parsedRange.kind === "partial") {
    headers["Content-Range"] = `bytes ${parsedRange.start}-${parsedRange.end}/${asset.byteSize}`;
  }

  return new NextResponse(streamBody, {
    status: parsedRange.kind === "partial" ? 206 : 200,
    headers,
  });
});
