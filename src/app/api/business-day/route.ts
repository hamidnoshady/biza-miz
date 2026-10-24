import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requireMember, requirePermission } from "@/lib/auth";
import { isValidStartMinutes, parseStartTime } from "@/lib/business-day";
import {
  BusinessDayError,
  getBusinessDayStatus,
  listBusinessDayClosures,
  setBusinessDayStart,
} from "@/lib/business-day-service";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { readJsonObject } from "@/lib/request-json";

/**
 * The active branch's business day (روز کاری): what it is configured to be,
 * which day is in progress, and where the live counters therefore start.
 *
 * ## Readable by any member (#933 item 7)
 *
 * This used to require `ledger.view`, so a cashier or a kitchen member opening
 * the dashboard could not see which day their screen was counting into. The
 * status is operational context, not accounting data; closure history is only
 * returned to somebody who can act on the branch's day or review its shifts.
 *
 * ## The three capabilities are computed, not guessed
 *
 * `canConfigure` (settings.manage), `canClose` (business_day.close) and
 * `canReviewShifts` (shifts.manage) come from the same effective permission set
 * the routes enforce. The old `canClose` was derived from `settings.manage`
 * while the close route demanded `ledger.close_period`, so the panel drew a
 * button whose only outcome was 403.
 */
export const GET = withTenantScope(async () => {
  const { session, membership, error } = await requireMember();
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const status = await getBusinessDayStatus(location.id);
  if (!status) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const permissions = membership.permissions;
  const canConfigure = permissions.has(PERMISSIONS.settingsManage);
  const canClose = permissions.has(PERMISSIONS.businessDayClose);
  const canReviewShifts = permissions.has(PERMISSIONS.shiftsManage);
  const closures = canClose || canReviewShifts ? await listBusinessDayClosures(location.id) : [];
  return NextResponse.json({
    businessDay: status,
    locationName: location.name,
    closures,
    canConfigure,
    canClose,
    canReviewShifts,
    // Kept for older clients that read the single flag; it means what it always
    // did in practice — may this caller close the day.
    canManage: canClose,
  });
});

interface ConfigureBody {
  /** "18:00", or null/"" to turn the business day off and go back to the calendar day. */
  startTime?: string | null;
  /** Minutes after local midnight — the same setting, for callers that already have a number. */
  startMinutes?: number | null;
}

/**
 * Turns the business day on or off for the active branch.
 *
 * Off is a real, reachable state and not an oversight: this is optional by
 * design, and a business that tries it and decides its day really does start
 * at midnight must be able to put it back exactly as it was.
 */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  const body = await readJsonObject(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  const value = body.value as ConfigureBody;

  if (value.startTime !== undefined && value.startTime !== null && typeof value.startTime !== "string") {
    // A number/array here would otherwise reach `.trim()` and surface as a 500.
    return NextResponse.json({ error: "invalid_start_time" }, { status: 400 });
  }

  let startMinutes: number | null;
  if (value.startTime !== undefined) {
    const text = (value.startTime ?? "").trim();
    if (text === "") {
      startMinutes = null;
    } else {
      const parsed = parseStartTime(text);
      if (parsed === null) {
        return NextResponse.json({ error: "invalid_start_time" }, { status: 400 });
      }
      startMinutes = parsed;
    }
  } else if (value.startMinutes === null) {
    startMinutes = null;
  } else if (isValidStartMinutes(value.startMinutes)) {
    startMinutes = value.startMinutes;
  } else {
    return NextResponse.json({ error: "invalid_start_time" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  try {
    const businessDay = await setBusinessDayStart(
      location.id,
      session.businessId,
      session.sub,
      startMinutes,
    );
    return NextResponse.json({ businessDay });
  } catch (err) {
    if (err instanceof BusinessDayError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
