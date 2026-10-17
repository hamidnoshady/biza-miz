import { NextRequest, NextResponse } from "next/server";
import { requireCompanionSession } from "@/lib/support-companion/companion-auth";
import {
  ARTIFACT_CHUNK_BYTES,
  getArtifactMeta,
  uploadArtifactChunk,
} from "@/lib/support-companion/artifacts";

/** Upload one chunk (base64 `data`, ≤256 KiB decoded). Idempotent per index:
 * re-sending identical bytes is a no-op; different bytes for the same index
 * are rejected, never silently overwritten. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompanionSession(request);
  if ("response" in auth) return auth.response;
  const session = auth.session;
  if (!session.scope.includes("report.upload")) {
    return NextResponse.json({ error: "scope_insufficient" }, { status: 403 });
  }
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const chunkIndex = typeof body.chunkIndex === "number" ? body.chunkIndex : -1;
  const data = typeof body.data === "string" ? body.data : "";
  if (chunkIndex < 0 || !data) {
    return NextResponse.json({ error: "index_and_data_required" }, { status: 400 });
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(data, "base64");
  } catch {
    return NextResponse.json({ error: "invalid_base64" }, { status: 400 });
  }
  if (bytes.length === 0 || bytes.length > ARTIFACT_CHUNK_BYTES) {
    return NextResponse.json({ error: "bad_chunk_size" }, { status: 400 });
  }

  // Ticket pinning: the artifact must belong to this session's ticket.
  const meta = await getArtifactMeta(session.businessId, id);
  if (!meta || meta.ticketId !== session.ticketId) {
    return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
  }

  const uploaded = await uploadArtifactChunk({
    businessId: session.businessId,
    artifactId: id,
    chunkIndex,
    bytes,
  });
  if (!uploaded.ok) {
    const status =
      uploaded.error === "artifact_not_found"
        ? 404
        : uploaded.error === "chunk_conflict" || uploaded.error === "not_uploading"
          ? 409
          : 400;
    return NextResponse.json({ error: uploaded.error }, { status });
  }
  return NextResponse.json({
    chunkIndex: uploaded.chunkIndex,
    chunkHash: uploaded.chunkHash,
    received: uploaded.received,
    expected: uploaded.expected,
  });
}
