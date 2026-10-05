import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireCapabilityForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { getRepairTicket } from "@/lib/repairs-service";
import { repairEstimateText } from "@/lib/watch-crm-service";
import { businessToday } from "@/lib/business-day-service";

/** The printable, signable estimate document for a ticket's current estimate. */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const capabilityError = await requireCapabilityForApi(session, "repairs");
  if (capabilityError) return capabilityError;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  const ticket = await getRepairTicket(id);
  if (!location || !ticket || ticket.locationId !== location.id) {
    return NextResponse.json({ error: "ticket_not_found" }, { status: 404 });
  }

  try {
    const prefs = await getSetting<{ currencyDisplay?: "toman" | "rial" }>(session.businessId, SETTING_KEYS.businessPrefs);
    // Issue #795 (item 21) — the estimate is dated in the business's own
    // local day, not the UTC calendar day.
    const text = await repairEstimateText(
      id,
      await businessToday(session.businessId),
      prefs?.currencyDisplay === "rial" ? "rial" : "toman",
    );
    return new NextResponse(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
