import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import {
  requireCompanionDevice,
  requireCompanionSession,
} from "@/lib/support-companion/companion-auth";
import { recordConsentEvent } from "@/lib/support-companion/consent";

/** The customer's local consent decision (or Stop), recorded from the
 * companion. Accepts either a support session JWT or the installation's own
 * device credential: stopping access must never depend on the operator's
 * authorization still being valid. */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const sessionAuth = await requireCompanionSession(request);
  const session = "session" in sessionAuth ? sessionAuth.session : null;
  const deviceAuth = session ? null : await requireCompanionDevice(request);
  const device = deviceAuth && "device" in deviceAuth ? deviceAuth.device : null;
  if (!session && !device) {
    return sessionAuth && "response" in sessionAuth
      ? sessionAuth.response
      : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const businessId = session ? session.businessId : device!.identity.businessId;
  const installationId = session ? session.installationId : device!.installation.id;
  const ticketId =
    (typeof body.ticketId === "string" ? body.ticketId : "") || (session ? session.ticketId : "");
  const subject = typeof body.subject === "string" ? body.subject : "";
  const decision = typeof body.decision === "string" ? body.decision : "";
  if (!ticketId || !subject || !decision) {
    return NextResponse.json({ error: "ticket_subject_and_decision_required" }, { status: 400 });
  }
  // A session is bound to one ticket: it cannot record consent for another.
  if (session && ticketId !== session.ticketId) {
    return NextResponse.json({ error: "ticket_mismatch" }, { status: 403 });
  }

  const recorded = await withTenant(businessId, async () =>
    recordConsentEvent({
      businessId,
      ticketId,
      installationId,
      subject,
      decision,
      grantedBy: "customer",
      scope:
        body.scope && typeof body.scope === "object"
          ? (body.scope as Record<string, unknown>)
          : {},
      expiresInMinutes: typeof body.expiresInMinutes === "number" ? body.expiresInMinutes : null,
    }),
  );
  if (!recorded.ok) {
    const status =
      recorded.error === "invalid_subject" || recorded.error === "invalid_decision" ? 400 : 404;
    return NextResponse.json({ error: recorded.error }, { status });
  }
  return NextResponse.json({ event: recorded.event }, { status: 201 });
}
