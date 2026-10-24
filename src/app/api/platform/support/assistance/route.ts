import { NextRequest, NextResponse } from "next/server";
import {
  CAPABILITIES_FOR,
  platformCan,
  type PlatformCapability,
} from "@/lib/platform-admin";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getSupportTicket } from "@/lib/platform-service";
import {
  expireStaleSessions,
  listTicketAssistanceSessions,
  requestAssistanceSession,
} from "@/lib/support-companion/assistance";
import { isSupportAssistanceCap } from "@/lib/support-companion/types";
import { clientIpFrom } from "@/lib/rate-limit";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** A ticket's assistance sessions for the support workspace. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("support.context.read");
  if (error) return error;

  const ticketId = request.nextUrl.searchParams.get("ticketId") ?? "";
  if (!isUuid(ticketId)) return NextResponse.json({ error: "ticket_required" }, { status: 400 });

  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await expireStaleSessions().catch(() => {});
  const sessions = await listTicketAssistanceSessions(ticket.businessId, ticketId);
  return NextResponse.json({ sessions });
});

/** Request remote assistance. View-only needs `support.assist.view`;
 * control/elevation need `support.assist.control`; both need recent MFA.
 * Customer approval still happens locally in the companion. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("support.assist.view");
  if (error) return error;
  if (!session.mfaVerified) return NextResponse.json({ error: "mfa_required" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
  const installationId = typeof body.installationId === "string" ? body.installationId : "";
  if (!isUuid(ticketId) || !isUuid(installationId)) {
    return NextResponse.json({ error: "ticket_and_installation_required" }, { status: 400 });
  }
  const caps = (Array.isArray(body.requestedCaps) ? body.requestedCaps : []).filter(
    isSupportAssistanceCap,
  );
  if (caps.length === 0) return NextResponse.json({ error: "caps_required" }, { status: 400 });
  const needsControl = caps.some((cap) => cap !== "view");
  const required: PlatformCapability = needsControl ? "support.assist.control" : "support.assist.view";
  if (!platformCan(session.role, required)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const created = await requestAssistanceSession({
    businessId: ticket.businessId,
    ticketId,
    installationId,
    operatorAdminId: session.padmin,
    requestedCaps: caps,
    reason: typeof body.reason === "string" ? body.reason : "",
    durationMinutes: typeof body.durationMinutes === "number" ? body.durationMinutes : undefined,
  });
  if (!created.ok) {
    const status =
      created.error === "reason_required" || created.error === "caps_required"
        ? 400
        : created.error === "session_already_live" ||
            created.error === "installation_not_active" ||
            created.error === "support_access_disabled"
          ? 409
          : 404;
    return NextResponse.json({ error: created.error }, { status });
  }

  await platformAudit({
    adminId: session.padmin,
    businessId: ticket.businessId,
    action: "support.assistance.requested",
    entity: "support_assistance_session",
    entityId: created.session.id,
    payload: { ticketId, installationId, requestedCaps: caps },
    ipAddress: clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ session: created.session }, { status: 201 });
});
