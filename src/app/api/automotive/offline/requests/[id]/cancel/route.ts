import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { deploymentRole } from "@/lib/deployment-role";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { resolveAutomotiveOfflineCapability } from "@/lib/automotive-offline";
import { cancelVehicleOfflineRequest } from "@/lib/automotive-stock-service";
import { handleAutomotiveError } from "../../../../guard";

/**
 * Issue #839 §19 — withdraw a queued vehicle request.
 *
 * The answer this route is allowed to give depends on what this install can
 * *prove*, and that is the whole point of the endpoint:
 *
 *  * nothing was ever handed to the cloud — the queued command is retracted in the
 *    same transaction as the request row, and the answer is `200` with
 *    `status: "cancelled"` and `cancelled: true`. This is the case that has to work
 *    while the branch is offline, and it does not need a round trip;
 *  * the command may already be with the cloud — the withdrawal travels as its own
 *    idempotent event (`automotive.vehicle.reservation.withdrawn`) and the answer
 *    is `202` with `status: "cancelling"`, `cancelled: false`: the counter is told
 *    the truth until the cloud has answered. The cloud either cancels a request it
 *    never applied, or releases the hold through the canonical reservation service
 *    — with that service's reasons, refund rules and audit trail — and the answer
 *    comes back through the ordinary request feed;
 *  * the cloud has already decided — the row's real status is returned (`409`), so
 *    a confirmed hold is released through the reservation flow rather than deleted.
 *
 * The old version of this route answered `{status: "cancelled"}` in every case and
 * left the queued event untouched, so the cloud went on and held the car. A
 * cancellation that the cloud can still apply is not a cancellation, and this route
 * no longer claims otherwise.
 *
 * Only a paired site queues these requests, so only a paired site can withdraw one:
 * on the cloud the row is the *outcome* of a request someone else queued, and its
 * lifecycle belongs to the applier. The capability check says so out loud instead of
 * relying on the caller to be the right kind of install.
 */
export const POST = withTenantScope(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    const { session, error } = await requirePermission(
      PERMISSIONS.vehiclesReservationCancel,
    );
    if (error) return error;
    const industryError = await requireIndustryForApi(session, "automotive");
    if (industryError) return industryError;

    const location = await resolveActiveLocation(session);
    if (!location)
      return NextResponse.json({ error: "no_location" }, { status: 409 });

    const { id } = await context.params;
    try {
      const profile = await readDeploymentProfile(session.businessId);
      const capability = resolveAutomotiveOfflineCapability({
        profile: profile.profile,
        runtimeRole: deploymentRole(),
      });
      if (!capability.reservationRequests) {
        return NextResponse.json(
          {
            error: "offline_requests_not_applicable",
            message: capability.label,
          },
          { status: 409 },
        );
      }

      const outcome = await cancelVehicleOfflineRequest({
        businessId: session.businessId,
        locationId: location.id,
        requestId: id,
        actorId: session.sub,
        actorRole: session.role,
      });
      if (!outcome) {
        return NextResponse.json(
          { error: "request_not_found", message: "درخواست یافت نشد." },
          { status: 404 },
        );
      }
      const body = {
        request: { id, status: outcome.status },
        action: outcome.action,
        cancelled: outcome.cancelled,
        message: outcome.message,
      };
      if (outcome.action === "withdrawn")
        return NextResponse.json(body, { status: 202 });
      if (outcome.action === "decided" && !outcome.cancelled) {
        return NextResponse.json(
          { error: "request_not_cancellable", ...body },
          { status: 409 },
        );
      }
      return NextResponse.json(body);
    } catch (err) {
      return handleAutomotiveError(err);
    }
  },
);
