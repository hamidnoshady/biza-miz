import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireCapabilityForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createRepairTicket, listRepairTickets } from "@/lib/repairs-service";
import { getBusinessVatPercent } from "@/lib/vat-policy-service";
import { REPAIR_STATUSES, type RepairStatus } from "@/lib/watch";

// Wave 10: repair_tickets is a shared module — a jewelry business repairing a
// clasp raises the same ticket a watch shop does, so the guard is the
// `repairs` capability (both trades have it) rather than `industry === watch`.
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const capabilityError = await requireCapabilityForApi(session, "repairs");
  if (capabilityError) return capabilityError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ tickets: [] });

  const statusParam = request.nextUrl.searchParams.get("status");
  const status = REPAIR_STATUSES.includes(statusParam as RepairStatus)
    ? (statusParam as RepairStatus)
    : undefined;

  const tickets = await listRepairTickets(location.id, { status });
  return NextResponse.json({ tickets });
});

/** Intake: takes a piece in and resolves whether the job is under warranty, once, from the linked unit's live window. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const capabilityError = await requireCapabilityForApi(session, "repairs");
  if (capabilityError) return capabilityError;

  let body: {
    itemDescription?: string;
    reportedIssue?: string | null;
    serialId?: string | null;
    customerId?: string | null;
    laborCharge?: number;
    vatPercent?: number;
    nonCoveredReason?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  // Issue #795 Phase 1 (item 22) — an omitted VAT rate resolves from the
  // business's one canonical tax configuration (the same `tax.config`
  // setting the wizard and Settings → Tax maintain), not a route literal:
  // a repair bill is as VAT-applicable as any other sale of this business.
  const vatPercent = body.vatPercent ?? (await getBusinessVatPercent(session.businessId));

  try {
    const ticket = await createRepairTicket({
      locationId: location.id,
      itemDescription: body.itemDescription ?? "",
      reportedIssue: body.reportedIssue ?? null,
      serialId: body.serialId || null,
      customerId: body.customerId || null,
      laborCharge: body.laborCharge ?? 0,
      vatPercent,
      nonCoveredReason: body.nonCoveredReason ?? null,
      createdBy: session.sub,
    });
    return NextResponse.json({ ok: true, ticket });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
