import { NextRequest, NextResponse } from "next/server";
import { CAPABILITIES_FOR } from "@/lib/platform-admin";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getSupportTicket } from "@/lib/platform-service";
import {
  appendSupportMessage,
  buildSupportEvidence,
  closeSupportConversation,
  getSupportConversation,
  investigateDeterministic,
  listSupportMessages,
  listSupportToolEvents,
  runSupportTurn,
} from "@/lib/support-companion/support-ai";
import { clientIpFrom } from "@/lib/rate-limit";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** One Support AI conversation with its transcript and audited tool events. */
export const GET = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformCapability("support.ai.use");
  if (error) return error;

  const { id } = await ctx.params;
  const ticketId = request.nextUrl.searchParams.get("ticketId") ?? "";
  if (!isUuid(id) || !isUuid(ticketId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const conversation = await getSupportConversation(ticket.businessId, id);
  if (!conversation || conversation.ticketId !== ticketId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const [messages, toolEvents] = await Promise.all([
    listSupportMessages(ticket.businessId, id),
    listSupportToolEvents(ticket.businessId, id),
  ]);
  return NextResponse.json({ conversation, messages, toolEvents });
});

export const POST = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("support.ai.use");
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
  if (!isUuid(id) || !isUuid(ticketId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const conversation = await getSupportConversation(ticket.businessId, id);
  if (!conversation || conversation.ticketId !== ticketId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (action === "close") {
    await closeSupportConversation(ticket.businessId, id);
    await platformAudit({
      adminId: session.padmin,
      businessId: ticket.businessId,
      action: "support.ai.conversation_closed",
      entity: "support_ai_conversation",
      entityId: id,
      payload: { ticketId },
      ipAddress: clientIpFrom(request.headers, 0),
      userAgent: request.headers.get("user-agent"),
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "investigate") {
    // Deterministic, offline-safe: no model call, no spend, no fabrication.
    const evidence = await buildSupportEvidence(ticket.businessId, ticketId);
    const summary = investigateDeterministic(evidence);
    await appendSupportMessage({
      businessId: ticket.businessId,
      conversationId: id,
      role: "assistant",
      content: summary,
    });
    return NextResponse.json({ summary });
  }

  if (action === "message") {
    const text = typeof body.body === "string" ? body.body : "";
    if (!text.trim()) return NextResponse.json({ error: "body_required" }, { status: 400 });
    const turn = await runSupportTurn({
      businessId: ticket.businessId,
      conversationId: id,
      operatorMessage: text,
      operatorCaps: CAPABILITIES_FOR(session.role),
      signal: request.signal,
    });
    if (!turn.ok) {
      const status =
        turn.error === "spend_limit_exceeded"
          ? 402
          : turn.error === "runtime_unavailable"
            ? 503
            : turn.error === "provider_failed"
              ? 502
              : 404;
      return NextResponse.json({ error: turn.error, detail: turn.detail ?? null }, { status });
    }
    return NextResponse.json({ reply: turn.reply, costUsd: turn.costUsd });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
});
