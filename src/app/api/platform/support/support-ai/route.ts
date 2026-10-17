import { NextRequest, NextResponse } from "next/server";
import { CAPABILITIES_FOR } from "@/lib/platform-admin";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getSupportTicket } from "@/lib/platform-service";
import {
  createSupportConversation,
  listTicketSupportConversations,
} from "@/lib/support-companion/support-ai";
import { clientIpFrom } from "@/lib/rate-limit";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** A ticket's Support AI conversations. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("support.ai.use");
  if (error) return error;

  const ticketId = request.nextUrl.searchParams.get("ticketId") ?? "";
  if (!isUuid(ticketId)) return NextResponse.json({ error: "ticket_required" }, { status: 400 });

  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const conversations = await listTicketSupportConversations(ticket.businessId, ticketId);
  return NextResponse.json({ conversations });
});

/** Open a ticket-scoped Support AI conversation. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("support.ai.use");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
  if (!isUuid(ticketId)) return NextResponse.json({ error: "ticket_required" }, { status: 400 });
  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const installationId = typeof body.installationId === "string" ? body.installationId : null;
  if (installationId !== null && !isUuid(installationId)) {
    return NextResponse.json({ error: "invalid_installation" }, { status: 400 });
  }
  const created = await createSupportConversation({
    businessId: ticket.businessId,
    ticketId,
    installationId,
    operatorAdminId: session.padmin,
    operatorCapabilities: CAPABILITIES_FOR(session.role),
    modelProfile: typeof body.modelProfile === "string" ? body.modelProfile : undefined,
    mode: typeof body.mode === "string" ? body.mode : undefined,
    spendLimitRial: typeof body.spendLimitRial === "number" ? body.spendLimitRial : undefined,
  });
  if (!created.ok) {
    const status =
      created.error === "profile_not_permitted"
        ? 403
        : created.error === "profile_unknown"
          ? 400
          : 404;
    return NextResponse.json({ error: created.error }, { status });
  }

  await platformAudit({
    adminId: session.padmin,
    businessId: ticket.businessId,
    action: "support.ai.conversation_opened",
    entity: "support_ai_conversation",
    entityId: created.conversation.id,
    payload: { ticketId, modelProfile: created.conversation.modelProfile },
    ipAddress: clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ conversation: created.conversation }, { status: 201 });
});
