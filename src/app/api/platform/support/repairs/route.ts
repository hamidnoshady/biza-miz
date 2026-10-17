import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getSupportTicket } from "@/lib/platform-service";
import {
  listActiveCatalog,
  listTicketRepairRuns,
  proposeRepair,
} from "@/lib/support-companion/repair-catalog";
import { clientIpFrom } from "@/lib/rate-limit";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** The active repair catalog, plus a ticket's repair runs when asked. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("support.context.read");
  if (error) return error;

  const catalog = await listActiveCatalog();
  const ticketId = request.nextUrl.searchParams.get("ticketId") ?? "";
  if (!ticketId) return NextResponse.json({ catalog, runs: [] });
  if (!isUuid(ticketId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const runs = await listTicketRepairRuns(ticket.businessId, ticketId);
  return NextResponse.json({ catalog, runs });
});

/** Propose an exact approved catalog recipe for a ticket. Execution is a
 * separate approval at the action boundary (`support.repair.execute`). */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("support.repair.propose");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
  const installationId = typeof body.installationId === "string" ? body.installationId : "";
  const recipeId = typeof body.recipeId === "string" ? body.recipeId.trim() : "";
  if (!isUuid(ticketId) || !isUuid(installationId) || !recipeId) {
    return NextResponse.json({ error: "ticket_installation_and_recipe_required" }, { status: 400 });
  }
  const ticket = await getSupportTicket(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const proposed = await proposeRepair({
    businessId: ticket.businessId,
    ticketId,
    installationId,
    requestId: typeof body.requestId === "string" ? body.requestId : null,
    runId: typeof body.runId === "string" ? body.runId : null,
    recipeId,
    recipeVersion: typeof body.recipeVersion === "number" ? body.recipeVersion : undefined,
    actor: "operator",
    operatorAdminId: session.padmin,
  });
  if (!proposed.ok) {
    const status =
      proposed.error === "recipe_not_found"
        ? 404
        : proposed.error === "recipe_not_active" || proposed.error === "installation_not_active"
          ? 409
          : 404;
    return NextResponse.json({ error: proposed.error }, { status });
  }

  await platformAudit({
    adminId: session.padmin,
    businessId: ticket.businessId,
    action: "support.repair.proposed",
    entity: "support_repair_run",
    entityId: proposed.run.id,
    payload: { ticketId, recipeId: proposed.run.recipeId, version: proposed.run.recipeVersion },
    ipAddress: clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ run: proposed.run }, { status: 201 });
});
