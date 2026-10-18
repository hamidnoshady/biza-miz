import { NextRequest, NextResponse } from "next/server";
import { requireCompanionSession } from "@/lib/support-companion/companion-auth";
import { beginArtifactUpload } from "@/lib/support-companion/artifacts";

/** Begin a chunked artifact upload for one of the session ticket's runs.
 * Requires the session's `report.upload` scope; the run pins
 * run↔ticket↔business scope server-side. */
export async function POST(request: NextRequest) {
  const auth = await requireCompanionSession(request);
  if ("response" in auth) return auth.response;
  const session = auth.session;
  if (!session.scope.includes("report.upload")) {
    return NextResponse.json({ error: "scope_insufficient" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const runId = typeof body.runId === "string" ? body.runId : "";
  const name = typeof body.name === "string" ? body.name : "";
  const sha256 = typeof body.sha256 === "string" ? body.sha256 : "";
  const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : -1;
  const chunkCount = typeof body.chunkCount === "number" ? body.chunkCount : -1;
  if (!runId || !name || !sha256 || sizeBytes < 0 || chunkCount < 0) {
    return NextResponse.json({ error: "run_name_hash_size_chunks_required" }, { status: 400 });
  }

  const begun = await beginArtifactUpload({
    businessId: session.businessId,
    ticketId: session.ticketId,
    runId,
    name,
    kind: typeof body.kind === "string" ? body.kind : undefined,
    mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined,
    sha256,
    sizeBytes,
    chunkCount,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
  });
  if (!begun.ok) {
    const status = begun.error === "run_not_found" ? 404 : 400;
    return NextResponse.json({ error: begun.error }, { status });
  }
  return NextResponse.json({ artifact: begun.artifact }, { status: 201 });
}
