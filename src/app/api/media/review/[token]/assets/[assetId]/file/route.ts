import { NextRequest, NextResponse } from "next/server";
import { parseHttpByteRange } from "@/lib/media";
import { authorizeReviewAsset, streamReviewAssetBytes } from "@/lib/media-review-service";
import {
  MEDIA_REVIEW_ERROR_STATUS,
  type MediaReviewErrorCode,
} from "../../../../../review-guard";

/**
 * Bytes for a client holding a live `download` link.
 *
 * This is the reason §E streams through the application rather than handing out a
 * presigned URL, even though `presignS3Get` already exists and would have been one
 * line. A presigned URL keeps working until it expires no matter what anybody
 * decides: with one, "revoke" would mean "wait up to thirty days", and a client
 * cut off for cause would still hold every file. Here the token is resolved and
 * the round's membership re-checked on every request, so revocation takes effect
 * immediately and each fetch is counted against the link.
 *
 * The `storage_key` never reaches this file. `authorizeReviewAsset` returns
 * metadata and a grant, and the service does the fetching, because a key that
 * leaves the service is a key that can end up in a log, a payload, or a URL
 * somebody forwards.
 *
 * `Cache-Control` is `no-store`, deliberately stronger than the tenant route's
 * `must-revalidate`: this URL carries a secret, so no cache, proxy or browser
 * history should retain the bytes keyed by it. That also means the `If-None-Match`
 * branch below is rarely exercised — it stays because it is cheap, and because a
 * client that ignores `no-store` should get a correct 304 rather than a fresh
 * download.
 *
 * Session-less like the rest of `/api/media/review/**`, and listed in
 * `api-guards.test.ts`'s `PUBLIC_ROUTES` for the reason given there: the client is
 * not a member, the token is the credential, and §B forbids solving that by giving
 * them a staff identity.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string; assetId: string }> },
): Promise<NextResponse> {
  const { token, assetId } = await context.params;

  // Authorise before touching storage: purpose, then round membership, then
  // existence. A refused request must not cost an object-store read.
  const authorized = await authorizeReviewAsset(token, assetId);
  if (!authorized.ok) return refused(authorized.code);
  const { grant, asset } = authorized;

  const etag = `"${asset.sha256}"`;
  const rangeHeader = request.headers.get("range");
  if (!rangeHeader && request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": NO_STORE, "Accept-Ranges": "bytes" },
    });
  }

  // Parse the range before opening a stream, so an unsatisfiable one is a 416 and
  // not a half-read object.
  const parsedRange = parseHttpByteRange(rangeHeader, asset.byteSize);
  if (parsedRange.kind === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${asset.byteSize}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": NO_STORE,
      },
    });
  }

  const rangeOption =
    parsedRange.kind === "partial"
      ? { start: parsedRange.start, end: parsedRange.end }
      : undefined;

  let streamed;
  try {
    streamed = await streamReviewAssetBytes(grant, asset.id, {
      range: rangeOption,
      signal: request.signal,
    });
  } catch {
    // An upstream object-store failure is a bad gateway, not a client error, and
    // must not be reported as one: the client did nothing wrong and retrying is
    // the right answer.
    return new NextResponse(null, { status: 502, headers: { "Cache-Control": NO_STORE } });
  }
  if (!streamed) return refused("storage_unavailable");

  // Inline for images and video so a client can actually look at what they are
  // approving; SVG is forced to an octet-stream attachment exactly as the tenant
  // route does, because rendering an uploaded SVG inline is script execution in
  // the app's own origin.
  const isSvg = asset.mimeType === "image/svg+xml";
  const inline = (asset.kind === "image" || asset.kind === "video") && !isSvg;
  const fileName = encodeURIComponent(asset.fileName);
  const headers: Record<string, string> = {
    "Content-Type": isSvg ? "application/octet-stream" : asset.mimeType,
    "Content-Length": String(streamed.contentLength),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${fileName}`,
    "Cache-Control": NO_STORE,
    ETag: etag,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  };
  if (parsedRange.kind === "partial") {
    headers["Content-Range"] = `bytes ${parsedRange.start}-${parsedRange.end}/${asset.byteSize}`;
  }

  return new NextResponse(streamed.stream, {
    status: parsedRange.kind === "partial" ? 206 : 200,
    headers,
  });
}

const NO_STORE = "private, no-store";

/** Answer a service refusal with the status the shared table assigns it. */
function refused(code: MediaReviewErrorCode): NextResponse {
  return NextResponse.json(
    { error: code },
    { status: MEDIA_REVIEW_ERROR_STATUS[code], headers: { "Cache-Control": NO_STORE } },
  );
}
