import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getSupportTicket } from "@/lib/platform-service";
import {
  createDiagnosticRequest,
  listTicketDiagnosticRequests,
  listTicketDiagnosticRuns,
} from "@/lib/support-companion/diagnostics";
import { isSupportOperation } from "@/lib/support-companion/types";
import { clientIpFrom } from "@/lib/rate-limit";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** A ticket's diagnostic requests and runs for the support workspace. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("support.context.read");
  if (error) return error;

  const ticketId = request.nextUrl.searchParams.get("ticketId") ?? "";
  if (!isUuid(ticketId)) return NextResponse.json({ error: "ticket_required" }, { status: 400 });

  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [requests, runs] = await Promise.all([
    listTicketDiagnosticRequests(ticket.businessId, ticketId),
    listTicketDiagnosticRuns(ticket.businessId, ticketId),
  ]);
  return NextResponse.json({ requests, runs });
});

/** Request diagnostics for a ticket's verified installation. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("support.diagnostics.request");
  if (error) return error;

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
  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const allowedOperations = Array.isArray(body.allowedOperations)
    ? (body.allowedOperations as unknown[]).filter(isSupportOperation)
    : ["diagnostics.run" as const];
  const created = await createDiagnosticRequest({
    businessId: ticket.businessId,
    ticketId,
    installationId,
    initiatedBy: "operator",
    operatorAdminId: session.padmin,
    modules: body.modules,
    reason: typeof body.reason === "string" ? body.reason : "",
    allowedOperations,
    expiresInMinutes: typeof body.expiresInMinutes === "number" ? body.expiresInMinutes : undefined,
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
  });
  if (!created.ok) {
    const status =
      created.error === "reason_required"
        ? 400
        : created.error === "installation_not_active" ||
            created.error === "support_access_disabled"
          ? 409
          : 404;
    return NextResponse.json({ error: created.error }, { status });
  }

  await platformAudit({
    adminId: session.padmin,
    businessId: ticket.businessId,
    action: "support.diagnostics.requested",
    entity: "support_diagnostic_request",
    entityId: created.request.id,
    payload: { ticketId, installationId, duplicate: created.duplicate },
    ipAddress: clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });
  return NextResponse.json(
    { request: created.request, duplicate: created.duplicate },
    { status: created.duplicate ? 200 : 201 },
  );
});
