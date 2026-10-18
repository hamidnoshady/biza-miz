import { NextRequest, NextResponse } from "next/server";
import { requireCompanionSession } from "@/lib/support-companion/companion-auth";
import {
  completeArtifactUpload,
  getArtifactMeta,
} from "@/lib/support-companion/artifacts";

/** Complete an upload: the server verifies chunk contiguity, total size and
 * the declared sha256, then marks the artifact `available`. Any mismatch
 * fails closed to `rejected` (bytes are never served half-assembled). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompanionSession(request);
  if ("response" in auth) return auth.response;
  const session = auth.session;
  if (!session.scope.includes("report.upload")) {
    return NextResponse.json({ error: "scope_insufficient" }, { status: 403 });
  }
  const { id } = await params;

  const meta = await getArtifactMeta(session.businessId, id);
  if (!meta || meta.ticketId !== session.ticketId) {
    return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
  }

  const completed = await completeArtifactUpload({
    businessId: session.businessId,
    artifactId: id,
  });
  if (!completed.ok) {
    const status =
      completed.error === "artifact_not_found"
        ? 404
        : completed.error === "incomplete"
          ? 409
          : completed.error === "not_uploading"
            ? 409
            : 422;
    return NextResponse.json({ error: completed.error }, { status });
  }
  return NextResponse.json({ artifact: completed.artifact });
}
