import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireCapabilityForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { addRepairPart, getRepairTicket } from "@/lib/repairs-service";
import type { RepairPartSource } from "@/lib/watch";

/** Records a part consumed on a ticket: what it cost the shop, and what the customer is billed for it (zero on a warranty job). */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const capabilityError = await requireCapabilityForApi(session, "repairs");
  if (capabilityError) return capabilityError;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  const ticket = await getRepairTicket(id);
  if (!location || !ticket || ticket.locationId !== location.id) {
    return NextResponse.json({ error: "ticket_not_found" }, { status: 404 });
  }

  let body: { description?: string; quantity?: string; unitCost?: number; charge?: number; source?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const part = await addRepairPart(id, {
      description: body.description ?? "",
      quantity: body.quantity ?? "1",
      unitCost: Number(body.unitCost ?? 0),
      charge: Number(body.charge ?? 0),
      // Validated by the service against REPAIR_PART_SOURCES; omitted means 'stock'.
      source: (body.source ?? "stock") as RepairPartSource,
    });
    return NextResponse.json({ ok: true, part });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
