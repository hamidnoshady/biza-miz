import { NextRequest, NextResponse } from "next/server";
import { CAPABILITIES_FOR } from "@/lib/platform-admin";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getSupportTicket } from "@/lib/platform-service";
import {
  issueOfflineToken,
  issueOnlineCode,
  listTicketAccessTokens,
} from "@/lib/support-companion/access-tokens";
import { isSupportTokenPurpose } from "@/lib/support-companion/types";
import { clientIpFrom } from "@/lib/rate-limit";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** A ticket's issued tokens: fingerprints, scope, expiry, redemption — never plaintext. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("support.context.read");
  if (error) return error;

  const ticketId = request.nextUrl.searchParams.get("ticketId") ?? "";
  if (!isUuid(ticketId)) return NextResponse.json({ error: "ticket_required" }, { status: 400 });

  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const tokens = await listTicketAccessTokens(ticket.businessId, ticketId);
  return NextResponse.json({ tokens });
});

/** Generate an on-site access token. The plaintext is returned ONCE in this
 * response (for the operator to hand to the technician / show as QR) and is
 * never stored; the audit row and the issuance record keep the fingerprint. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("support.token.issue");
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
  const purpose = body.purpose;
  if (!isUuid(ticketId) || !isUuid(installationId) || !isSupportTokenPurpose(purpose)) {
    return NextResponse.json({ error: "ticket_installation_and_purpose_required" }, { status: 400 });
  }
  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const base = {
    businessId: ticket.businessId,
    ticketId,
    installationId,
    issuerAdminId: session.padmin,
    issuerCapabilities: CAPABILITIES_FOR(session.role),
    requestedScope: body.requestedScope,
    reason: typeof body.reason === "string" ? body.reason : "",
    validityMinutes: typeof body.validityMinutes === "number" ? body.validityMinutes : undefined,
  };
  const issued =
    purpose === "online_code"
      ? await issueOnlineCode(base)
      : await issueOfflineToken({
          ...base,
          technicianBindingHash:
            typeof body.technicianBindingHash === "string" ? body.technicianBindingHash : "",
          challenge: typeof body.challenge === "string" ? body.challenge : "",
        });
  if (!issued.ok) {
    const status =
      issued.error === "reason_required" || issued.error === "scope_empty"
        ? 400
        : issued.error === "signing_unavailable"
          ? 503
          : issued.error === "installation_not_active" ||
              issued.error === "support_access_disabled"
            ? 409
            : 404;
    return NextResponse.json({ error: issued.error }, { status });
  }

  await platformAudit({
    adminId: session.padmin,
    businessId: ticket.businessId,
    action: "support.access_token.issued",
    entity: "support_access_token",
    entityId: issued.record.id,
    payload: {
      ticketId,
      installationId,
      purpose,
      scope: issued.record.scope,
      fingerprint: issued.record.fingerprint,
    },
    ipAddress: clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });
  // The one and only time the plaintext exists outside the technician's hands.
  return NextResponse.json({ record: issued.record, plaintext: issued.plaintext }, { status: 201 });
});
