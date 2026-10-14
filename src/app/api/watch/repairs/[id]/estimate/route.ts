import { NextRequest, NextResponse } from "next/server";
import { type SessionPayload, withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireCapabilityForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getRepairTicket } from "@/lib/repairs-service";
import { approveRepairEstimate, setRepairEstimate } from "@/lib/watch-crm-service";

async function ownedTicket(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const ticket = await getRepairTicket(id);
  if (!ticket || ticket.locationId !== location.id) return null;
  return ticket;
}

/** Records (or replaces) the labour/parts estimate the customer is asked to approve. */
export const PUT = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const capabilityError = await requireCapabilityForApi(session, "repairs");
  if (capabilityError) return capabilityError;
  const { id } = await context.params;

  const ticket = await ownedTicket(session, id);
  if (!ticket) return NextResponse.json({ error: "ticket_not_found" }, { status: 404 });

  let body: { laborRial?: number; partsRial?: number; discountRial?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const estimate = await setRepairEstimate(id, {
      laborRial: Number(body.laborRial ?? 0),
      partsRial: Number(body.partsRial ?? 0),
      discountRial: Number(body.discountRial ?? 0),
    });
    return NextResponse.json({ ok: true, estimate });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});

/** The customer's approval stamps the ticket, so work can start and the ticket can close. */
export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const capabilityError = await requireCapabilityForApi(session, "repairs");
  if (capabilityError) return capabilityError;
  const { id } = await context.params;

  const ticket = await ownedTicket(session, id);
  if (!ticket) return NextResponse.json({ error: "ticket_not_found" }, { status: 404 });

  try {
    const estimate = await approveRepairEstimate(id);
    return NextResponse.json({ ok: true, estimate });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
