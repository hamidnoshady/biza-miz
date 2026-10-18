import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import {
  requireCompanionDevice,
  requireCompanionSession,
} from "@/lib/support-companion/companion-auth";
import {
  getAssistanceSession,
  recordLocalConsent,
  renewSessionLease,
  revokeAssistanceSession,
} from "@/lib/support-companion/assistance";

/** Companion-side assistance transitions, each re-checked against the live
 * session row: `consent` (the customer's local approve/deny), `renew_lease`
 * (one 30-second epoch on a live lease), `stop` (the local Stop switch —
 * immediate, from any live state, and never dependent on the operator's
 * authorization surviving). */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!action || !sessionId) {
    return NextResponse.json({ error: "action_and_session_required" }, { status: 400 });
  }

  // Stop works on the device credential alone; consent and lease renewal
  // need the ticket-bound session.
  const sessionAuth = await requireCompanionSession(request);
  const session = "session" in sessionAuth ? sessionAuth.session : null;
  if (!session && action !== "stop") {
    return "response" in sessionAuth
      ? sessionAuth.response
      : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const deviceAuth = session ? null : await requireCompanionDevice(request);
  const device = deviceAuth && "device" in deviceAuth ? deviceAuth.device : null;
  if (!session && !device) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const businessId = session ? session.businessId : device!.identity.businessId;
  const installationId = session ? session.installationId : device!.installation.id;

  const guard = await withTenant(businessId, async () => {
    const current = await getAssistanceSession(businessId, sessionId);
    if (!current || current.installationId !== installationId) return null;
    if (session && current.ticketId !== session.ticketId) return null;
    return current;
  });
  if (!guard) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (action === "consent" && session) {
    if (!session.scope.includes("remote.view") && !session.scope.includes("remote.control")) {
      return NextResponse.json({ error: "scope_insufficient" }, { status: 403 });
    }
    const decided = await withTenant(businessId, async () =>
      recordLocalConsent({
        businessId,
        sessionId,
        approved: body.approved === true,
        approvedCaps: body.approvedCaps,
        proof:
          body.proof && typeof body.proof === "object"
            ? (body.proof as Record<string, unknown>)
            : {},
      }),
    );
    if (!decided.ok) {
      const status = decided.error === "caps_required" ? 400 : 409;
      return NextResponse.json({ error: decided.error }, { status });
    }
    return NextResponse.json({ session: decided.session });
  }

  if (action === "renew_lease" && session) {
    const renewed = await withTenant(businessId, async () => renewSessionLease(businessId, sessionId));
    if (!renewed.ok) {
      const status = renewed.error === "session_not_found" ? 404 : 409;
      return NextResponse.json({ error: renewed.error }, { status });
    }
    return NextResponse.json({ session: renewed.session });
  }

  if (action === "stop") {
    const stopped = await withTenant(businessId, async () =>
      revokeAssistanceSession(businessId, sessionId, "customer", "customer_stop"),
    );
    if (!stopped.ok) return NextResponse.json({ error: stopped.error }, { status: 409 });
    return NextResponse.json({ session: stopped.session });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
