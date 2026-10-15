import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { deploymentRole } from "@/lib/deployment-role";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import {
  AUTOMOTIVE_RESERVABLE_STATES,
  recordVehicleReleaseRequest,
  recordVehicleReservationRequest,
} from "@/lib/automotive-stock-service";
import {
  validateVehicleReservationDraft,
  resolveAutomotiveOfflineCapability,
} from "@/lib/automotive-offline";
import { businessToday } from "@/lib/automotive-service";
import { getPool } from "@/lib/db";
import { handleAutomotiveError, readBody } from "../../guard";
import type { QueuedVehicleRequest } from "@/lib/automotive-stock-service";

/**
 * What the desk is told about a submission — the row the database actually holds.
 *
 * `status` is read back rather than assumed (`"pending"` used to be hardcoded on
 * both branches, so a re-submitted request the cloud had already refused was shown
 * as «در انتظار تأیید» again), and `adopted` says whether the row that counts is a
 * *different* open request for the same car — in which case the id returned is that
 * request's, so the counter's cancel and retry buttons act on something real.
 */
function requestSubmissionBody(result: QueuedVehicleRequest) {
  return {
    request: { id: result.requestId, status: result.status },
    duplicate: result.duplicate,
    adopted: result.adopted,
  };
}

/**
 * Issue #839 §19 — queue a vehicle hold (`reserve`) or the release of a hold
 * this branch placed (`release`).
 *
 * Everything about this route says "intent", because that is what it is:
 *
 *  * it refuses to run at all for an install that is not a paired site
 *    (`resolveAutomotiveOfflineCapability`): the cloud applies such a change
 *    directly through `/api/automotive/reservations`, and a Local-profile
 *    install is its own authority;
 *  * the draft is validated with the *same* rules the canonical reservation
 *    service enforces (`validateVehicleReservationDraft`), so a request that
 *    could only ever conflict is refused at the counter with a sentence;
 *  * the response is a **pending** request — never a hold. The mirror will not
 *    show the car as reserved until the cloud confirms it, the deposit does not
 *    post until then, and the UI renders «در انتظار تأیید سرور»;
 *  * the request id is the idempotency key (it becomes the `sync_events`
 *    `client_event_id`), so a retried submission lands once.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const body = await readBody(request);
  const kind = body.kind === "release" ? "release" : "reserve";
  const { session, error } = await requirePermission(
    kind === "release"
      ? PERMISSIONS.vehiclesReservationCancel
      : PERMISSIONS.vehiclesReserve,
  );
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "automotive");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location)
    return NextResponse.json({ error: "no_location" }, { status: 409 });

  try {
    const profile = await readDeploymentProfile(session.businessId);
    const capability = resolveAutomotiveOfflineCapability({
      profile: profile.profile,
      runtimeRole: deploymentRole(),
    });
    if (!capability.reservationRequests || !capability.releaseRequests) {
      return NextResponse.json(
        { error: "offline_requests_not_applicable", message: capability.label },
        { status: 409 },
      );
    }

    const requestId =
      typeof body.requestId === "string" && body.requestId
        ? body.requestId
        : randomUUID();

    if (kind === "release") {
      const reservationId =
        typeof body.reservationId === "string" ? body.reservationId : "";
      const serialId = typeof body.serialId === "string" ? body.serialId : "";
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reservationId || !serialId || !reason) {
        return NextResponse.json(
          {
            error: "reason_required",
            message: "دلیل آزادسازی رزرو الزامی است.",
          },
          { status: 400 },
        );
      }
      const result = await recordVehicleReleaseRequest({
        businessId: session.businessId,
        locationId: location.id,
        requestId,
        reservationId,
        serialId,
        stockNumber:
          typeof body.stockNumber === "string" ? body.stockNumber : "",
        reason,
        refundDeposit:
          body.refundDeposit === undefined
            ? undefined
            : body.refundDeposit === true,
        expectedVersion: Number.isSafeInteger(body.expectedVersion)
          ? (body.expectedVersion as number)
          : 1,
        expectedState: "reserved",
        actorId: session.sub,
        actorRole: session.role,
      });
      return NextResponse.json(requestSubmissionBody(result));
    }

    const client = await getPool().connect();
    let today: string;
    try {
      today = await businessToday(client, location.id);
    } finally {
      client.release();
    }
    const validation = validateVehicleReservationDraft(body, {
      reservableStates: AUTOMOTIVE_RESERVABLE_STATES,
      today,
    });
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error, message: validation.message },
        { status: 400 },
      );
    }
    const draft = validation.draft;
    const result = await recordVehicleReservationRequest({
      businessId: session.businessId,
      locationId: location.id,
      requestId,
      serialId: draft.serialId,
      stockNumber: typeof body.stockNumber === "string" ? body.stockNumber : "",
      customerId: draft.customerId,
      customerName: draft.customerName,
      expiresAt: draft.expiresAt,
      expiresAtTime: draft.expiresAtTime,
      depositRial: draft.depositRial,
      depositMethod: draft.depositMethod,
      depositRefundable: draft.depositRefundable,
      depositNote: draft.depositNote,
      note: draft.note,
      expectedVersion: draft.expectedVersion,
      expectedState: draft.expectedState,
      actorId: session.sub,
      actorRole: session.role,
    });
    return NextResponse.json(requestSubmissionBody(result));
  } catch (err) {
    return handleAutomotiveError(err);
  }
});
