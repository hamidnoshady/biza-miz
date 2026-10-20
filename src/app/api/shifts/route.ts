import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  listShifts,
  shiftHistoryFilterOptions,
  SHIFT_PAGE_MAX,
  SHIFT_PAGE_SIZE,
} from "@/lib/shift-service";
import { accessibleLocationIdsForUser } from "@/lib/setup-state";

/**
 * Shift history for the admin review tab (Phase 20 Wave 5).
 *
 * Gated on `shifts.manage` since issue #933 — a capability of its own, held by
 * the roles that already administrated shifts, rather than `team.manage`
 * borrowed from credential administration.
 *
 * ## Branch scope (#933 item 5)
 *
 * The filter is the caller's **reachable branches**, resolved from the live
 * membership with the same `location-access` rule every screen uses. A
 * constrained manager asking for another branch's history gets 403; one who
 * omits the branch sees only the branches they can reach. A manager cannot
 * widen this by sending an id.
 *
 * ## Filters (#933 items 11 and 12)
 *
 * Branch, employee, business-date range, shift id, status, "has a variance" and
 * "closed unresolved" — plus a stable `(started_at, id)` order so paging cannot
 * duplicate or skip rows that share a start time.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.shiftsManage);
  if (error) return error;

  const allowedLocationIds = await accessibleLocationIdsForUser(session.businessId, session.sub);
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const locationId = searchParams.get("locationId") ?? undefined;
  if (locationId && !allowedLocationIds.includes(locationId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const limit = Number(searchParams.get("limit") ?? SHIFT_PAGE_SIZE);
  const offset = Number(searchParams.get("offset") ?? 0);

  const [page, options] = await Promise.all([
    listShifts(session.businessId, {
      employeeId: searchParams.get("employeeId") ?? undefined,
      locationId,
      locationIds: allowedLocationIds,
      status: status === "open" || status === "closed" ? status : undefined,
      shiftId: searchParams.get("shiftId") ?? undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      onlyVariance: searchParams.get("onlyVariance") === "1",
      onlyUnresolved: searchParams.get("onlyUnresolved") === "1",
      // A non-numeric `?limit=` is a malformed query string, not a request for
      // zero rows: fall back to the default rather than returning an empty list
      // the caller cannot tell apart from "no shifts yet".
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), SHIFT_PAGE_MAX) : SHIFT_PAGE_SIZE,
      offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0,
    }),
    shiftHistoryFilterOptions(session.businessId, allowedLocationIds),
  ]);

  return NextResponse.json({
    ...page,
    options,
    capabilities: { canForceClose: true, canAdjust: true },
  });
});
