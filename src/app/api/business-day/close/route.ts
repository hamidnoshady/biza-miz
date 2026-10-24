import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  BusinessDayError,
  closeBusinessDay,
  reopenBusinessDay,
} from "@/lib/business-day-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { idempotencyKey, readJsonObject } from "@/lib/request-json";

/**
 * «بستن روز کاری» — ending the business day in progress early, and undoing
 * that.
 *
 * ## Permission (#933 item 7)
 *
 * `business_day.close`, not `ledger.close_period`. The panel computed its
 * "close" button from `settings.manage` while this route demanded the
 * accountant's period-closing key, so the default manager saw a button that
 * could only 403. The capability now names the act, and the GET that draws the
 * button reads the same key.
 *
 * ## Atomic and retry-safe (#933 item 8)
 *
 * The service takes a per-branch advisory lock and relies on a partial unique
 * index for "one active close per branch-day". A close retried with the same
 * `Idempotency-Key` returns the closure it already recorded instead of
 * `business_day_already_closed`.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.businessDayClose);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const body = await readJsonObject(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  const note = typeof body.value.note === "string" ? body.value.note.trim() || null : null;
  if (body.value.note !== undefined && body.value.note !== null && typeof body.value.note !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const key = idempotencyKey(request);
  if (key === undefined) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  try {
    const businessDay = await closeBusinessDay(
      location.id,
      session.businessId,
      session.sub,
      note,
      { requestId: key },
    );
    return NextResponse.json({ businessDay });
  } catch (err) {
    if (err instanceof BusinessDayError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});

/**
 * Undoes a close taken by mistake, putting the window back to the day's
 * scheduled start.
 *
 * `?closureId=` names one row (history is kept: the row is marked reopened,
 * not deleted). Without it the closure holding the current window is undone —
 * which is what the panel's single button means.
 *
 * The response says what the reopen does **not** undo. A close emits a
 * coworker `day_close` event and a notification; reopening the window leaves
 * both in place, and any automation that already ran needs a compensating
 * action, not a second click on this button (#933 item 8).
 */
export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.businessDayClose);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { searchParams } = new URL(request.url);
  const closureId = searchParams.get("closureId") ?? null;
  const note = searchParams.get("note")?.trim() || null;

  try {
    const businessDay = await reopenBusinessDay(
      location.id,
      session.businessId,
      session.sub,
      { closureId, note },
    );
    return NextResponse.json({
      businessDay,
      closureId: businessDay.closureId ?? null,
      reopenEffects: businessDay.reopenEffects ?? [],
    });
  } catch (err) {
    if (err instanceof BusinessDayError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
