import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { getMemberTicket, TicketAccessError } from "@/lib/support-service";
import {
  getDiagnosticRequest,
  listTicketDiagnosticRequests,
  listTicketDiagnosticRuns,
  transitionDiagnosticRequest,
} from "@/lib/support-companion/diagnostics";
import {
  getAssistanceSession,
  listTicketAssistanceSessions,
  revokeAssistanceSession,
} from "@/lib/support-companion/assistance";
import { recordConsentEvent } from "@/lib/support-companion/consent";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** The member's own ticket diagnostics: requests, runs and assistance
 * sessions with truthful states. Ordinary tenant access never unlocks
 * diagnostic execution — that authority lives in support tokens. */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireMember();
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const ticket = await getMemberTicket({
      businessId: session.businessId,
      userId: session.sub,
      role: session.role,
      ticketId: id,
    });
    if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const [requests, runs, assistance] = await Promise.all([
      listTicketDiagnosticRequests(session.businessId, id),
      listTicketDiagnosticRuns(session.businessId, id),
      listTicketAssistanceSessions(session.businessId, id),
    ]);
    return NextResponse.json({ requests, runs, assistance });
  } catch (err) {
    if (err instanceof TicketAccessError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
});

/** The customer's Stop switch from their ticket: `stop_request` cancels a
 * live diagnostic request, `stop_session` revokes an assistance session,
 * `revoke_consent` records a consent revocation. Effective immediately and
 * locally — never gated on operator authorization. */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireMember();
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";

  try {
    const ticket = await getMemberTicket({
      businessId: session.businessId,
      userId: session.sub,
      role: session.role,
      ticketId: id,
    });
    if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

    if (action === "stop_request") {
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      if (!isUuid(requestId)) return NextResponse.json({ error: "request_required" }, { status: 400 });
      const current = await getDiagnosticRequest(session.businessId, requestId);
      if (!current || current.ticketId !== id) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      const stopped = await transitionDiagnosticRequest(session.businessId, requestId, "cancelled");
      if (!stopped.ok) return NextResponse.json({ error: stopped.error }, { status: 409 });
      await recordConsentEvent({
        businessId: session.businessId,
        ticketId: id,
        installationId: current.installationId,
        subject: "diagnostics",
        decision: "revoked",
        grantedBy: "customer",
      });
      return NextResponse.json({ request: stopped.request });
    }

    if (action === "stop_session") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!isUuid(sessionId)) return NextResponse.json({ error: "session_required" }, { status: 400 });
      const current = await getAssistanceSession(session.businessId, sessionId);
      if (!current || current.ticketId !== id) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      const stopped = await revokeAssistanceSession(
        session.businessId,
        sessionId,
        "customer",
        "customer_stop",
      );
      if (!stopped.ok) return NextResponse.json({ error: stopped.error }, { status: 409 });
      return NextResponse.json({ session: stopped.session });
    }

    if (action === "revoke_consent") {
      const installationId = typeof body.installationId === "string" ? body.installationId : "";
      const subject = typeof body.subject === "string" ? body.subject : "";
      if (!isUuid(installationId) || !subject) {
        return NextResponse.json({ error: "installation_and_subject_required" }, { status: 400 });
      }
      const recorded = await recordConsentEvent({
        businessId: session.businessId,
        ticketId: id,
        installationId,
        subject,
        decision: "revoked",
        grantedBy: "customer",
      });
      if (!recorded.ok) {
        const status = recorded.error === "invalid_subject" ? 400 : 404;
        return NextResponse.json({ error: recorded.error }, { status });
      }
      return NextResponse.json({ event: recorded.event }, { status: 201 });
    }

    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } catch (err) {
    if (err instanceof TicketAccessError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
});
