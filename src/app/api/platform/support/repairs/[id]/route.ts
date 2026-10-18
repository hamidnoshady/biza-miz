import { NextRequest, NextResponse } from "next/server";
import { platformCan } from "@/lib/platform-admin";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getSupportTicket } from "@/lib/platform-service";
import { getRepairRun, transitionRepairRun } from "@/lib/support-companion/repair-catalog";
import { consentAllows } from "@/lib/support-companion/consent";
import { clientIpFrom } from "@/lib/rate-limit";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** One repair run. */
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
  const run = await getRepairRun(ticket.businessId, id);
  if (!run || run.ticketId !== ticketId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ run });
});

/** Operator-side transitions: `approve` (→ authorized, owner-only +
 * MFA + live customer consent), `decline`, `cancel`. Execution-side
 * transitions (executing/verifying/succeeded/…) arrive from the verified
 * companion, never from a browser. */
export const POST = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const guard = await requirePlatformCapability("support.repair.propose");
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
  const run = await getRepairRun(ticket.businessId, id);
  if (!run || run.ticketId !== ticketId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const auditBase = {
    adminId: session.padmin,
    businessId: ticket.businessId,
    entity: "support_repair_run",
    entityId: id,
    ipAddress: clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  };

  if (action === "approve") {
    if (!platformCan(session.role, "support.repair.execute")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (!session.mfaVerified) return NextResponse.json({ error: "mfa_required" }, { status: 403 });
    const consented = await consentAllows(ticket.businessId, run.installationId, "repair");
    if (!consented) return NextResponse.json({ error: "consent_missing" }, { status: 409 });
    const transitioned = await transitionRepairRun(ticket.businessId, id, "authorized");
    if (!transitioned.ok) {
      return NextResponse.json({ error: transitioned.error }, { status: 409 });
    }
    await platformAudit({
      ...auditBase,
      action: "support.repair.authorized",
      payload: { ticketId, recipeId: run.recipeId, version: run.recipeVersion },
    });
    return NextResponse.json({ run: transitioned.run });
  }

  if (action === "decline" || action === "cancel") {
    const to = action === "decline" ? "declined" : "cancelled";
    const transitioned = await transitionRepairRun(ticket.businessId, id, to);
    if (!transitioned.ok) {
      return NextResponse.json({ error: transitioned.error }, { status: 409 });
    }
    await platformAudit({ ...auditBase, action: `support.repair.${to}`, payload: { ticketId } });
    return NextResponse.json({ run: transitioned.run });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
});
