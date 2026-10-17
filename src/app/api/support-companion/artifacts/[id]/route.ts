import { NextRequest, NextResponse } from "next/server";
import { requireCompanionSession } from "@/lib/support-companion/companion-auth";
import {
  abortArtifactUpload,
  getArtifactMeta,
} from "@/lib/support-companion/artifacts";

/** Read an artifact's metadata (never its bytes — those go to the platform
 * console only). Lets the companion poll upload state after reconnecting. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  return NextResponse.json({ artifact: meta });
}

/** Abort an in-flight upload: staged chunks are deleted and the row moves to
 * `rejected`. Terminal rows report `already_terminal` honestly. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const aborted = await abortArtifactUpload({ businessId: session.businessId, artifactId: id });
  if (!aborted.ok) {
    return NextResponse.json({ error: aborted.error }, { status: 404 });
  }
  return NextResponse.json({ alreadyTerminal: aborted.alreadyTerminal });
}
