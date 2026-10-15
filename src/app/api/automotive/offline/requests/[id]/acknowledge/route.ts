import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { acknowledgeVehicleOfflineRequest } from "@/lib/automotive-stock-service";
import { handleAutomotiveError } from "../../../../guard";

/**
 * Issue #839 §19 — an operator has read the cloud's refusal.
 *
 * The refusal itself is final and cannot be deleted: the row is the audit trail
 * of a request that was queued, sent to the cloud and refused there. This route
 * only records that a person dealt with it, so the sync panel's «نیازمند تصمیم»
 * count matches reality while the history stays complete. A second call is a
 * no-op — the first acknowledgement's timestamp is never rewritten.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.vehiclesReservationCancel);
    if (error) return error;
    const industryError = await requireIndustryForApi(session, "automotive");
    if (industryError) return industryError;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    const { id } = await context.params;
    try {
      const acknowledged = await acknowledgeVehicleOfflineRequest({
        businessId: session.businessId,
        locationId: location.id,
        requestId: id,
        actorId: session.sub,
      });
      if (!acknowledged) {
        return NextResponse.json(
          { error: "request_not_acknowledgeable", message: "این درخواست تعارض بازی برای تأیید خواندن ندارد." },
          { status: 409 },
        );
      }
      return NextResponse.json({ request: { id, acknowledged: true } });
    } catch (err) {
      return handleAutomotiveError(err);
    }
  },
);
