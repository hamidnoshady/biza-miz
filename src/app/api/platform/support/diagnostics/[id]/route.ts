import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getSupportTicket } from "@/lib/platform-service";
import {
  getDiagnosticRequest,
  transitionDiagnosticRequest,
} from "@/lib/support-companion/diagnostics";
import { clientIpFrom } from "@/lib/rate-limit";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function resolveBusinessId(ticketId: string): Promise<string | null> {
  const ticket = await getSupportTicket(ticketId);
  return ticket?.businessId ?? null;
}

/** One diagnostic request. */
export const GET = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformCapability("support.context.read");
  if (error) return error;

  const { id } = await ctx.params;
  const ticketId = request.nextUrl.searchParams.get("ticketId") ?? "";
  if (!isUuid(id) || !isUuid(ticketId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const businessId = await resolveBusinessId(ticketId);
  if (!businessId) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const found = await getDiagnosticRequest(businessId, id);
  if (!found || found.ticketId !== ticketId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ request: found });
});

/** Operator lifecycle: cancel a live request. Completion states are written
 * by the companion's run receipts, never by the operator's browser. */
export const POST = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("support.diagnostics.request");
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
  if (!isUuid(id) || !isUuid(ticketId) || action !== "cancel") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const businessId = await resolveBusinessId(ticketId);
  if (!businessId) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const current = await getDiagnosticRequest(businessId, id);
  if (!current || current.ticketId !== ticketId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const transitioned = await transitionDiagnosticRequest(businessId, id, "cancelled");
  if (!transitioned.ok) {
    return NextResponse.json({ error: transitioned.error }, { status: 409 });
  }
  await platformAudit({
    adminId: session.padmin,
    businessId,
    action: "support.diagnostics.cancelled",
    entity: "support_diagnostic_request",
    entityId: id,
    payload: { ticketId },
    ipAddress: clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ request: transitioned.request });
});
