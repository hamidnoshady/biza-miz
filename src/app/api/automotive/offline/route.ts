import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { deploymentRole } from "@/lib/deployment-role";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import {
  AUTOMOTIVE_OFFLINE_REQUEST_STATUSES,
  resolveAutomotiveOfflineCapability,
  type AutomotiveOfflineRequestStatus,
} from "@/lib/automotive-offline";
import {
  automotiveMirrorStatus,
  listMirrorVehicles,
  listVehicleOfflineRequests,
} from "@/lib/automotive-stock-service";
import { handleAutomotiveError } from "../guard";

/**
 * Issue #839 §19 — what *this install* may do with a car, and what it holds
 * locally right now.
 *
 * One round trip, three answers, in the order a counter clerk needs them:
 *
 *  1. **the capability** (`resolveAutomotiveOfflineCapability`) — a Local-profile
 *     business is its own system of record, a paired site holds a read-only
 *     mirror and may queue holds, and the cloud role *is* the authority. The
 *     answer comes from the business's deployment profile and this process's
 *     runtime role, never from connectivity: authority must not change when the
 *     Wi-Fi drops;
 *  2. **the mirror's freshness and counts** — how stale the board is and how
 *     many requests are waiting on the cloud, so the UI can say «همگام»,
 *     «قدیمی» or «در انتظار تأیید» instead of implying certainty it does not
 *     have;
 *  3. **the rows** — the branch's mirrored vehicles and this branch's queued
 *     (and already answered) requests.
 *
 * Reads only. Nothing here can create a hold, take a deposit or move a car; the
 * writes live on `./requests` and are queued, never applied locally.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.vehiclesView);
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
    const url = new URL(request.url);
    const requestStatusParam = url.searchParams.get("requestStatus");
    const requestStatus = (
      AUTOMOTIVE_OFFLINE_REQUEST_STATUSES as readonly string[]
    ).includes(requestStatusParam ?? "")
      ? (requestStatusParam as AutomotiveOfflineRequestStatus)
      : null;
    const [status, vehicles, requestPage] = await Promise.all([
      automotiveMirrorStatus(session.businessId, location.id),
      listMirrorVehicles(session.businessId, location.id, {
        condition:
          url.searchParams.get("condition") === "new" ||
          url.searchParams.get("condition") === "used"
            ? (url.searchParams.get("condition") as "new" | "used")
            : null,
        state: url.searchParams.get("state"),
        search: url.searchParams.get("search"),
      }),
      // The requests arrive as a page, never as a silently truncated window: the
      // open ones always (that is the work the counter must act on) and the settled
      // history newest-first behind a keyset cursor the panel follows with
      // `cursor`/`nextCursor`. `total` and `openTotal` are counted under the same
      // filter the rows are read with, so a header can never promise more rows than
      // the list can reach.
      listVehicleOfflineRequests(
        session.businessId,
        location.id,
        requestStatus ?? undefined,
        {
          unacknowledgedOnly: url.searchParams.get("unacknowledged") === "1",
          cursor: url.searchParams.get("cursor"),
          limit: Number(url.searchParams.get("limit")) || undefined,
        },
      ),
    ]);
    return NextResponse.json({
      capability,
      deployment: {
        profile: profile.profile,
        pairedAt: profile.pairedAt,
        source: profile.source,
      },
      status,
      vehicles,
      requests: requestPage.rows,
      requestsPage: {
        total: requestPage.total,
        openTotal: requestPage.openTotal,
        nextCursor: requestPage.nextCursor,
      },
    });
  } catch (err) {
    return handleAutomotiveError(err);
  }
});
