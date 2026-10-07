/**
 * The business day (روز کاری) — the DB-touching half (not unit-tested
 * directly, per repo convention; the rules it applies live in business-day.ts
 * and are covered by business-day.test.ts).
 *
 * One read answers everything the app needs about a branch's trading day: the
 * configured start, which business day is in progress, when it began and ends,
 * whether management has closed it early, and therefore where the live
 * counters start. Every caller — the dashboard KPIs, the orders screen, the
 * settings panel — goes through `getBusinessDayStatus` rather than deriving a
 * window of its own, so no two screens can disagree about what "today" means.
 *
 * The date arithmetic is SQL's (`app_business_date` and friends, migration
 * 0076): the branch's timezone is a column, and doing it here would mean
 * re-implementing zone conversion in JavaScript for the sake of a value the
 * reporting views compute the other way anyway.
 */
import { getPool, query } from "./db";
import {
  isValidStartMinutes,
  resolveLiveWindow,
  type LiveWindowCloseReason,
} from "./business-day";
import { postgresDateToIso } from "./jalali";
import { recordCoworkerEvent } from "./ai-coworker-events";
import { recordNotification } from "./notification-events";
import { notificationDedupeKey } from "./notifications";
import { toPersianDigits } from "./digits";

export class BusinessDayError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

async function auditBusinessDay(
  businessId: string,
  actorId: string | null,
  action: string,
  locationId: string,
  payload?: unknown,
): Promise<void> {
  await getPool().query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'business_day', $4, $5)`,
    [businessId, actorId, action, locationId, JSON.stringify(payload ?? null)],
  );
}

export interface BusinessDayStatus {
  locationId: string;
  timeZone: string;
  /** Minutes after local midnight, or null when the branch has not configured a business day. */
  startMinutes: number | null;
  /** False = the calendar day applies, exactly as it did before this feature existed. */
  enabled: boolean;
  /** The business day in progress, as an ISO date — what a report would file right now's sales under. */
  businessDate: string;
  /** When that day began and when it ends on its own, as ISO instants. */
  scheduledStart: string;
  scheduledEnd: string;
  /**
   * Where the live counters start: the scheduled start, or — once the branch has
   * finished its night — the cash-up or manual close that ended it.
   */
  windowStart: string;
  /** How the night was ended early ("shift" = the cashier's cash-up), or null while it runs. */
  closedBy: LiveWindowCloseReason | null;
  manuallyClosed: boolean;
  /** The branch's most recent manual close, whether or not it still holds the window. */
  lastClosedAt: string | null;
  lastClosedByName: string | null;
  /** The branch's most recent shift cash-up, and whether anyone is still clocked in. */
  lastShiftEndedAt: string | null;
  hasOpenShift: boolean;
}

interface StatusRow extends Record<string, unknown> {
  timezone: string;
  business_day_start_minutes: number | null;
  business_date: Date;
  scheduled_start: Date;
  scheduled_end: Date;
  last_closed_at: Date | null;
  last_closed_by_name: string | null;
  last_shift_ended_at: Date | null;
  has_open_shift: boolean | null;
}

/**
 * The branch's trading day as of now. Returns null only when `locationId` names
 * no branch this tenant can see — every real branch has a status, since a
 * branch with no business day configured simply reports the calendar day.
 */
export async function getBusinessDayStatus(
  locationId: string,
): Promise<BusinessDayStatus | null> {
  const { rows } = await query<StatusRow>(
    `SELECT l.timezone,
            l.business_day_start_minutes,
            app_business_date(now(), l.timezone, l.business_day_start_minutes)      AS business_date,
            app_business_day_start(now(), l.timezone, l.business_day_start_minutes) AS scheduled_start,
            app_business_day_end(now(), l.timezone, l.business_day_start_minutes)   AS scheduled_end,
            c.closed_at                                                             AS last_closed_at,
            u.full_name                                                             AS last_closed_by_name,
            s.last_shift_ended_at,
            s.has_open_shift
       FROM locations l
       LEFT JOIN LATERAL (
         SELECT closed_at, closed_by
           FROM business_day_closures
          WHERE location_id = l.id
          ORDER BY closed_at DESC
          LIMIT 1
       ) c ON true
       LEFT JOIN users u ON u.id = c.closed_by
       -- The branch's till state. A shift with no branch of its own counts for
       -- it, the same rule listRecentShiftOptions and branchClosedOrdersWindow
       -- already apply: a shift only records a branch when the session that
       -- opened it had one, and dropping those rows here would mean a
       -- single-branch business never registered its own cash-up.
       LEFT JOIN LATERAL (
         SELECT max(es.ended_at)          AS last_shift_ended_at,
                bool_or(es.ended_at IS NULL) AS has_open_shift
           FROM employee_shifts es
          WHERE es.location_id = l.id OR es.location_id IS NULL
       ) s ON true
      WHERE l.id = $1`,
    [locationId],
  );
  const row = rows[0];
  if (!row) return null;

  const startMinutes = row.business_day_start_minutes;
  const enabled = startMinutes !== null;
  const scheduledStart = row.scheduled_start.toISOString();
  const scheduledEnd = row.scheduled_end.toISOString();
  const lastClosedAt = row.last_closed_at
    ? row.last_closed_at.toISOString()
    : null;
  const lastShiftEndedAt = row.last_shift_ended_at
    ? row.last_shift_ended_at.toISOString()
    : null;
  const hasOpenShift = row.has_open_shift === true;
  const { windowStart, closedBy, manuallyClosed } = resolveLiveWindow({
    enabled,
    scheduledStart,
    scheduledEnd,
    lastClosedAt,
    lastShiftEndedAt,
    hasOpenShift,
  });

  return {
    locationId,
    timeZone: row.timezone,
    startMinutes,
    enabled,
    // row.business_date is a Postgres `date` — node-postgres hands it back as a
    // local-midnight Date, so slicing toISOString() would shift it a day on any
    // runner east of UTC (see postgresDateToIso).
    businessDate: postgresDateToIso(row.business_date),
    scheduledStart,
    scheduledEnd,
    windowStart,
    closedBy,
    manuallyClosed,
    lastClosedAt,
    lastClosedByName: row.last_closed_by_name,
    lastShiftEndedAt,
    hasOpenShift,
  };
}

/**
 * Turns the business day on (a start time) or off (null) for one branch.
 *
 * Changing it re-buckets the branch's reporting history, because the views
 * derive each row's date from the current setting rather than from a stored
 * column — that is what makes the setting mean "this is how our day works"
 * rather than "from today onwards", and why the change is audited.
 */
export async function setBusinessDayStart(
  locationId: string,
  businessId: string,
  actorId: string | null,
  startMinutes: number | null,
): Promise<BusinessDayStatus> {
  if (startMinutes !== null && !isValidStartMinutes(startMinutes)) {
    throw new BusinessDayError("invalid_start_time", 400);
  }
  const { rows } = await query<{ id: string }>(
    `UPDATE locations
        SET business_day_start_minutes = $3
      WHERE id = $1 AND business_id = $2
      RETURNING id`,
    [locationId, businessId, startMinutes],
  );
  if (!rows[0]) throw new BusinessDayError("location_not_found", 404);

  await auditBusinessDay(
    businessId,
    actorId,
    "business_day.configured",
    locationId,
    {
      startMinutes,
    },
  );
  const status = await getBusinessDayStatus(locationId);
  if (!status) throw new BusinessDayError("location_not_found", 404);
  return status;
}

/**
 * "بستن روز کاری" — ends the business day in progress early, so the dashboard
 * and the orders screen start the next one from zero straight away instead of
 * waiting for the configured start time to come round.
 *
 * Refused when the branch has no business day configured: without one there is
 * no window for a closure to shorten, and recording one would leave a row that
 * does nothing until someone turns the feature on months later. Refused too
 * when the current day is already closed, so a second click cannot quietly
 * move the window on again.
 */
export async function closeBusinessDay(
  locationId: string,
  businessId: string,
  actorId: string | null,
  note: string | null = null,
): Promise<BusinessDayStatus> {
  const status = await getBusinessDayStatus(locationId);
  if (!status) throw new BusinessDayError("location_not_found", 404);
  if (!status.enabled)
    throw new BusinessDayError("business_day_not_configured", 409);
  if (status.manuallyClosed)
    throw new BusinessDayError("business_day_already_closed", 409);

  const { rows } = await query<{ id: string; closed_at: Date }>(
    `INSERT INTO business_day_closures (business_id, location_id, business_date, closed_by, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, closed_at`,
    [businessId, locationId, status.businessDate, actorId, note],
  );
  await auditBusinessDay(
    businessId,
    actorId,
    "business_day.closed",
    locationId,
    {
      businessDate: status.businessDate,
      closureId: rows[0]?.id ?? null,
    },
  );

  // Phase 32 — «بستن روز کاری» is the third thing a coworker job can wait for.
  await recordCoworkerEvent({
    businessId,
    locationId,
    kind: "day_close",
    payload: { businessDate: status.businessDate, closureId: rows[0]?.id ?? null },
  });

  // Phase 35 — and the fourth thing worth telling an owner who is not here.
  // Keyed on the business date rather than on the closure id, so a close,
  // reopen and close of the same day is one notification, not three.
  await recordNotification({
    businessId,
    locationId,
    eventKey: "business_day.closed",
    severity: "info",
    title: "روز کاری بسته شد",
    body: `روز ${toPersianDigits(status.businessDate)} در این شعبه بسته شد.`,
    url: "/settings/shifts",
    dedupeKey: notificationDedupeKey("business_day.closed", locationId, status.businessDate),
    payload: { businessDate: status.businessDate, closureId: rows[0]?.id ?? null },
  });

  const updated = await getBusinessDayStatus(locationId);
  if (!updated) throw new BusinessDayError("location_not_found", 404);
  return updated;
}

/**
 * Undoes a close taken by mistake, putting the live window back to the
 * business day's scheduled start. Only the closure holding the *current*
 * window can be undone — history stays history — and the row is deleted rather
 * than flagged, since a closure that no longer applies has nothing left to
 * say and the audit log already records both the close and this reopen.
 */
export async function reopenBusinessDay(
  locationId: string,
  businessId: string,
  actorId: string | null,
): Promise<BusinessDayStatus> {
  const status = await getBusinessDayStatus(locationId);
  if (!status) throw new BusinessDayError("location_not_found", 404);
  if (!status.manuallyClosed)
    throw new BusinessDayError("business_day_not_closed", 409);

  await query(
    `DELETE FROM business_day_closures
      WHERE location_id = $1 AND business_id = $2 AND closed_at >= $3 AND closed_at < $4`,
    [locationId, businessId, status.scheduledStart, status.scheduledEnd],
  );
  await auditBusinessDay(
    businessId,
    actorId,
    "business_day.reopened",
    locationId,
    {
      businessDate: status.businessDate,
    },
  );

  const updated = await getBusinessDayStatus(locationId);
  if (!updated) throw new BusinessDayError("location_not_found", 404);
  return updated;
}

export interface BusinessDayClosure {
  id: string;
  businessDate: string;
  closedAt: string;
  closedByName: string | null;
  note: string | null;
}

/** The branch's recent manual closes, newest first — the settings panel's history list. */
export async function listBusinessDayClosures(
  locationId: string,
  limit = 30,
): Promise<BusinessDayClosure[]> {
  const { rows } = await query<{
    id: string;
    business_date: Date;
    closed_at: Date;
    closed_by_name: string | null;
    note: string | null;
  }>(
    `SELECT c.id, c.business_date, c.closed_at, u.full_name AS closed_by_name, c.note
       FROM business_day_closures c
       LEFT JOIN users u ON u.id = c.closed_by
      WHERE c.location_id = $1
      ORDER BY c.closed_at DESC
      LIMIT $2`,
    [locationId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    businessDate: postgresDateToIso(row.business_date),
    closedAt: row.closed_at.toISOString(),
    closedByName: row.closed_by_name,
    note: row.note,
  }));
}


/**
 * The business's current business date, from its primary active branch — the
 * business-wide counterpart of `getBusinessDayStatus`, for the callers that
 * have a business but no particular branch in hand (the cross-server rollup,
 * the AI assistant's default date range).
 *
 * "Primary" is the oldest active branch, which is the same branch the rollup
 * has always taken its timezone from; a business whose branches keep different
 * hours gets that one's trading day, exactly as it already got that one's
 * timezone. Falls back to Asia/Tehran and the calendar day when a business has
 * no active branch at all, so a caller always gets a usable date.
 */
export async function businessToday(businessId: string): Promise<string> {
  const { rows } = await query<{ today: string }>(
    `SELECT app_business_date(
              now(),
              coalesce(l.timezone, 'Asia/Tehran'),
              l.business_day_start_minutes
            )::text AS today
       FROM (SELECT 1) one
       LEFT JOIN LATERAL (
         SELECT timezone, business_day_start_minutes
           FROM locations
          WHERE business_id = $1 AND is_active
          ORDER BY created_at
          LIMIT 1
       ) l ON true`,
    [businessId],
  );
  return rows[0].today;
}

/**
 * The zone `businessToday` reads the calendar in for this business's primary
 * branch — the same coalesced column value, exposed so callers that bucket
 * *stored* timestamps by calendar day can cast in the zone that produced the
 * day they compare against.
 *
 * Why that matters: `due_at::date` casts in the SESSION zone, while the day it
 * is compared to comes from here. Tehran is UTC+3:30 with no DST, so for the
 * 20:30–24:00 UTC slice of every day the two dates disagree, and a follow-up
 * due at tonight's 23:00 satisfies `due_at::date < today` — «عقب‌افتاده»
 * gaining a row that «امروز» simultaneously loses. Casts that must agree with
 * the business date take their zone from this function, not from the session.
 */
export async function businessTimeZone(businessId: string): Promise<string> {
  const { rows } = await query<{ tz: string }>(
    `SELECT coalesce(l.timezone, 'Asia/Tehran') AS tz
       FROM (SELECT 1) one
       LEFT JOIN LATERAL (
         SELECT timezone
           FROM locations
          WHERE business_id = $1 AND is_active
          ORDER BY created_at
          LIMIT 1
       ) l ON true`,
    [businessId],
  );
  return rows[0].tz;
}

/**
 * «امروز» for one specific branch — the business date *that* branch's own
 * timezone and day-start produce, not the primary branch's.
 *
 * Why this exists: a manual journal draft is stored with the branch it will
 * post to (`journal_entry_drafts.location_id`), and the form says «خالی یعنی
 * تاریخ امروز». Resolving that "today" against the primary branch instead of
 * the draft's own branch is how a Tehran head office's late-night entry got
 * filed under a different calendar day than the branch it belongs to — and
 * unlike a receipt, a draft's date is not re-derived at approval time, so the
 * wrong day was the day that posted.
 *
 * A branch that cannot be resolved (an unknown id, a branch archived since the
 * draft was written, a business with none) still gets a usable date: the
 * business-wide `businessToday` is the last resort, never `CURRENT_DATE`.
 */
export async function locationBusinessToday(
  businessId: string,
  locationId: string | null | undefined,
): Promise<string> {
  if (!locationId) return businessToday(businessId);
  const { rows } = await query<{ today: string }>(
    `SELECT app_business_date(now(), l.timezone, l.business_day_start_minutes)::text AS today
       FROM locations l
      WHERE l.id = $1 AND l.business_id = $2`,
    [locationId, businessId],
  );
  return rows[0]?.today ?? (await businessToday(businessId));
}
