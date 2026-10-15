import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { cancelVehicleOfflineRequest } from "@/lib/automotive-stock-service";
import { handleAutomotiveError } from "../../../../guard";

/**
 * Issue #839 §19 — withdraw a queued vehicle request.
 *
 * Only a `pending` row can be withdrawn, and only by the branch that queued it:
 * the cloud's answer is final (`validateOfflineRequestTransition`), so a
 * confirmed hold is released through the ordinary reservation flow — which
 * refunds a refundable deposit and leaves an audit trail — rather than by
 * deleting the evidence that it ever existed. A cancelled request never reaches
 * the cloud if the push has not run yet; if it already left, the cloud simply
 * applies nothing, because a cancelled row carries no event of its own.
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
      const cancelled = await cancelVehicleOfflineRequest({
        businessId: session.businessId,
        locationId: location.id,
        requestId: id,
        actorId: session.sub,
      });
      if (!cancelled) {
        return NextResponse.json(
          { error: "request_not_cancellable", message: "این درخواست دیگر در انتظار تأیید نیست." },
          { status: 409 },
        );
      }
      return NextResponse.json({ request: { id, status: "cancelled" } });
    } catch (err) {
      return handleAutomotiveError(err);
    }
  },
);
