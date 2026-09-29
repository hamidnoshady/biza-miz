import { NextRequest, NextResponse } from "next/server";
import {
  appendRestoreChunk,
  discardRestoreUpload,
  isRestoreUploadId,
  parseChunkParams,
  RESTORE_UPLOAD_MAX_CHUNK_BYTES,
  sweepStaleRestoreUploads,
} from "./restore-upload";

/**
 * The HTTP half of a chunked restore upload, shared by the Owner dashboard
 * (scope = the business id) and the first-run screen (scope = `setup`). The
 * caller has already decided the request may upload at all.
 *
 * `POST ?id=<uuid>&offset=<n>` with the raw piece as the body. The answer is
 * the staged size, or 409 `offset_mismatch` with the size to resume from.
 */
export async function handleRestoreChunk(request: NextRequest, scope: string): Promise<NextResponse> {
  const params = parseChunkParams(
    request.nextUrl.searchParams.get("id"),
    request.nextUrl.searchParams.get("offset"),
  );
  if (!params.ok) return NextResponse.json({ error: params.error }, { status: 400 });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > RESTORE_UPLOAD_MAX_CHUNK_BYTES) {
    return NextResponse.json({ error: "chunk_too_large" }, { status: 413 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());

  if (params.offset === 0) await sweepStaleRestoreUploads().catch(() => 0);
  const outcome = await appendRestoreChunk(scope, params.id, params.offset, bytes);
  if (!outcome.ok) {
    if (outcome.error === "offset_mismatch") {
      return NextResponse.json({ error: outcome.error, size: outcome.size }, { status: 409 });
    }
    return NextResponse.json({ error: outcome.error }, { status: 413 });
  }
  return NextResponse.json({ ok: true, size: outcome.size });
}

/** `DELETE ?id=<uuid>` — drop a staged upload the Owner no longer wants. */
export async function handleRestoreDiscard(request: NextRequest, scope: string): Promise<NextResponse> {
  const id = request.nextUrl.searchParams.get("id");
  if (!isRestoreUploadId(id)) return NextResponse.json({ error: "invalid_upload_id" }, { status: 400 });
  await discardRestoreUpload(scope, id);
  return NextResponse.json({ ok: true });
}
