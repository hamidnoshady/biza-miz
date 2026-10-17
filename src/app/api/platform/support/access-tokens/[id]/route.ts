import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getSupportTicket } from "@/lib/platform-service";
import { revokeAccessToken } from "@/lib/support-companion/access-tokens";
import { clientIpFrom } from "@/lib/rate-limit";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Revoke a pending token. Connected sessions presenting it fail on their
 * next verification; disconnected on-site use keeps its signed deadline. */
export const POST = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("support.token.issue");
  if (error) return error;

  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (!isUuid(id) || !isUuid(ticketId) || action !== "revoke") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const revoked = await revokeAccessToken(ticket.businessId, id);
  if (!revoked.ok) return NextResponse.json({ error: revoked.error }, { status: 404 });

  await platformAudit({
    adminId: session.padmin,
    businessId: ticket.businessId,
    action: "support.access_token.revoked",
    entity: "support_access_token",
    entityId: id,
    payload: { ticketId, alreadyTerminal: revoked.alreadyTerminal },
    ipAddress: clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true, alreadyTerminal: revoked.alreadyTerminal });
});
