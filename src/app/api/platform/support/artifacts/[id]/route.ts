import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getSupportTicket } from "@/lib/platform-service";
import { getArtifactMeta, getArtifactPayload } from "@/lib/support-companion/artifacts";
import { clientIpFrom } from "@/lib/rate-limit";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** One artifact's metadata (`?ticketId=…`, `support.context.read`), or its
 * bytes with `&download=1` (`support.reports.read`, audited — artifact
 * payloads are the one support surface that carries raw collector output). */
export const GET = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;
  const ticketId = request.nextUrl.searchParams.get("ticketId") ?? "";
  const download = request.nextUrl.searchParams.get("download") === "1";
  if (!isUuid(id) || !isUuid(ticketId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const cap = download ? "support.reports.read" : "support.context.read";
  const { session, error } = await requirePlatformCapability(cap);
  if (error) return error;

  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (!download) {
    const meta = await getArtifactMeta(ticket.businessId, id);
    if (!meta || meta.ticketId !== ticketId || meta.deletedAt) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ artifact: meta });
  }

  const payload = await getArtifactPayload(ticket.businessId, id);
  if (!payload.ok || payload.artifact.ticketId !== ticketId) {
    const status = payload.ok ? 404 : payload.error === "artifact_not_found" ? 404 : 410;
    return NextResponse.json({ error: payload.ok ? "not_found" : payload.error }, { status });
  }
  await platformAudit({
    adminId: session.padmin,
    businessId: ticket.businessId,
    action: "support.artifact.download",
    entity: "support_diagnostic_artifact",
    entityId: id,
    payload: { ticketId, name: payload.artifact.name, sizeBytes: payload.artifact.sizeBytes },
    ipAddress: clientIpFrom(request.headers, 0),
  });
  return new NextResponse(new Uint8Array(payload.payload), {
    status: 200,
    headers: {
      "Content-Type": payload.artifact.mimeType,
      "Content-Length": String(payload.payload.length),
      "Content-Disposition": `attachment; filename="${payload.artifact.name.replaceAll('"', "")}"`,
      "Cache-Control": "no-store",
    },
  });
});
