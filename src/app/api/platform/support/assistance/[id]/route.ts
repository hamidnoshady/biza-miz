import { NextRequest, NextResponse } from "next/server";
import { platformCan } from "@/lib/platform-admin";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getSupportTicket } from "@/lib/platform-service";
import {
  endAssistanceSession,
  getAssistanceSession,
  listAssistanceEvents,
  operatorJoinSession,
  revokeAssistanceSession,
} from "@/lib/support-companion/assistance";
import { clientIpFrom } from "@/lib/rate-limit";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** One assistance session with its event history. */
export const GET = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformCapability("support.context.read");
  if (error) return error;

  const { id } = await ctx.params;
  const ticketId = request.nextUrl.searchParams.get("ticketId") ?? "";
  if (!isUuid(id) || !isUuid(ticketId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const session = await getAssistanceSession(ticket.businessId, id);
  if (!session || session.ticketId !== ticketId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const events = await listAssistanceEvents(ticket.businessId, id);
  return NextResponse.json({ session, events });
});

/** Operator actions: `join` (MFA + matching view/control cap), `end`, `revoke`. */
export const POST = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const guard = await requirePlatformCapability("support.assist.view");
  if (guard.error) return guard.error;
  const session = guard.session;

  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (!isUuid(id) || !isUuid(ticketId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const current = await getAssistanceSession(ticket.businessId, id);
  if (!current || current.ticketId !== ticketId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const auditBase = {
    adminId: session.padmin,
    businessId: ticket.businessId,
    entity: "support_assistance_session",
    entityId: id,
    ipAddress: clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  };

  if (action === "join") {
    if (!session.mfaVerified) return NextResponse.json({ error: "mfa_required" }, { status: 403 });
    const needsControl = current.requestedCaps.some((cap) => cap !== "view");
    const required = needsControl ? "support.assist.control" : "support.assist.view";
    if (!platformCan(session.role, required)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const joined = await operatorJoinSession(ticket.businessId, id, session.padmin);
    if (!joined.ok) {
      const status =
        joined.error === "provider_not_configured" || joined.error === "agent_not_linked"
          ? 409
          : joined.error === "provider_unreachable" || joined.error === "provider_error"
            ? 502
            : 400;
      return NextResponse.json({ error: joined.error }, { status });
    }
    await platformAudit({ ...auditBase, action: "support.assistance.joined", payload: { ticketId } });
    // The guest URL is returned once, here — it is never stored on the
    // session row and never visible to companion-facing reads.
    return NextResponse.json({ session: joined.session, operatorUrl: joined.operatorUrl });
  }

  if (action === "end" || action === "revoke") {
    if (!platformCan(session.role, "support.assist.revoke")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const reason = typeof body.reason === "string" ? body.reason : "";
    const ended =
      action === "revoke"
        ? await revokeAssistanceSession(ticket.businessId, id, `operator:${session.padmin}`, reason)
        : await endAssistanceSession(ticket.businessId, id, `operator:${session.padmin}`, reason);
    if (!ended.ok) return NextResponse.json({ error: ended.error }, { status: 409 });
    await platformAudit({
      ...auditBase,
      action: action === "revoke" ? "support.assistance.revoked" : "support.assistance.ended",
      payload: { ticketId },
    });
    return NextResponse.json({ session: ended.session });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
});
