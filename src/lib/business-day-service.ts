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
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import {
  isValidStartMinutes,
  resolveLiveWindow,
  type LiveWindowCloseReason,
} from "./business-day";
import { postgresDateToIso } from "./jalali";
import { isUuid } from "./uuid";
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
  /** The active closure holding the window, if any (issue #933 item 8: reopen targets one row). */
  lastClosureId: string | null;
  /**
   * Set on the object a close/reopen returns: the closure row it acted on.
   * Optional because a plain status read has no single row to name.
   */
  closureId?: string | null;
  /**
   * Set on a reopen: work the close already triggered that reopening does *not*
   * undo (a `day_close` coworker event, a queued notification). The panel shows
   * this instead of implying the reopen reversed anything but the window.
   */
  reopenEffects?: string[];
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
  last_closure_id: string | null;
}

/**
 * The branch's trading day as of now. Returns null only when `locationId` names
 * no branch this tenant can see — every real branch has a status, since a
 * branch with no business day configured simply reports the calendar day.
 *
 * `client` lets a caller inside a transaction read the same state it is about
 * to change, under the same lock. A close that read through the pool would be
 * reading a different connection's snapshot — the exact read-then-write gap
 * issue #933 item 8 is about.
 */
const BUSINESS_DAY_STATUS_SQL = `
  SELECT l.timezone,
         l.business_day_start_minutes,
         app_business_date(now(), l.timezone, l.business_day_start_minutes)      AS business_date,
         app_business_day_start(now(), l.timezone, l.business_day_start_minutes) AS scheduled_start,
         app_business_day_end(now(), l.timezone, l.business_day_start_minutes)   AS scheduled_end,
         c.id                                                                    AS last_closure_id,
         c.closed_at                                                             AS last_closed_at,
         u.full_name                                                             AS last_closed_by_name,
         s.last_shift_ended_at,
         s.has_open_shift
    FROM locations l
    LEFT JOIN LATERAL (
      -- Only an *active* closure (migration 0233) holds the window; a reopened
      -- one is history and must not keep applying.
      SELECT id, closed_at, closed_by
        FROM business_day_closures
       WHERE location_id = l.id AND reopened_at IS NULL
       ORDER BY closed_at DESC
       LIMIT 1
    ) c ON true
    LEFT JOIN users u ON u.id = c.closed_by
    -- The branch's till state. A shift only records a branch when the session
    -- that opened it had one, so legacy rows carry 'location_id IS NULL'.
    -- app_shift_attribution_branch (migration 0233) resolves such a row to
    -- the one branch it can belong to, or to NULL — an explicit unknown that
    -- matches no branch. Before it, one branch's forgotten shift could hold
    -- another branch's reporting window open (#933 item 6).
    LEFT JOIN LATERAL (
      SELECT max(es.ended_at)          AS last_shift_ended_at,
             bool_or(es.ended_at IS NULL) AS has_open_shift
        FROM employee_shifts es
       WHERE app_shift_attribution_branch(es.business_id, es.location_id, es.employee_id) = l.id
    ) s ON true
   WHERE l.id = $1
`;

async function readBusinessDayStatus(
  client: PoolClient | null,
  locationId: string,
): Promise<BusinessDayStatus | null> {
  const { rows } = client
    ? await client.query<StatusRow>(BUSINESS_DAY_STATUS_SQL, [locationId])
    : await query<StatusRow>(BUSINESS_DAY_STATUS_SQL, [locationId]);
  const row = rows[0];
  if (!row) return null;

  const startMinutes = row.business_day_start_minutes;
  const enabled = startMinutes !== null;
  const scheduledStart = row.scheduled_start.toISOString();
  const scheduledEnd = row.scheduled_end.toISOString();
  const lastClosedAt = row.last_closed_at ? row.last_closed_at.toISOString() : null;
  const lastShiftEndedAt = row.last_shift_ended_at ? row.last_shift_ended_at.toISOString() : null;
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
    lastClosureId: row.last_closure_id,
  };
}

export async function getBusinessDayStatus(
  locationId: string,
): Promise<BusinessDayStatus | null> {
  return readBusinessDayStatus(null, locationId);
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
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `UPDATE locations
          SET business_day_start_minutes = $3
        WHERE id = $1 AND business_id = $2
        RETURNING id`,
      [locationId, businessId, startMinutes],
    );
    if (!rows[0]) throw new BusinessDayError("location_not_found", 404);
    // The setting re-buckets the branch's whole reporting history, so its audit
    // row is part of the change rather than an afterthought that could fail
    // once the setting is already live (#933 item 1's shape, applied here too).
    await client.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'business_day.configured', 'business_day', $3, $4)`,
      [businessId, actorId, locationId, JSON.stringify({ startMinutes })],
    );
    const status = await readBusinessDayStatus(client, locationId);
    if (!status) throw new BusinessDayError("location_not_found", 404);
    await client.query("COMMIT");
    return status;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * «بستن روز کاری» — ends the business day in progress early, so the dashboard
 * and the orders screen start the next one from zero straight away instead of
 * waiting for the configured start time to come round.
 *
 * ## Atomic and idempotent (#933 item 8)
 *
 * The old version read the status, checked `manuallyClosed`, and inserted — three
 * round trips with no lock between them, so two concurrent closes could both
 * pass the check and both insert. This runs in one transaction, takes a
 * transaction-scoped advisory lock keyed on the branch, and relies on
 * `idx_business_day_closures_one_active` (one active closure per branch-day) as
 * the database-level backstop. A caller that sends `requestId` gets its own
 * closure back on a retry instead of `business_day_already_closed`.
 *
 * Refused when the branch has no business day configured: without one there is
 * no window for a closure to shorten, and recording one would leave a row that
 * does nothing until someone turns the feature on months later.
 *
 * A close emits a coworker `day_close` event (and a notification) after the
 * commit. Reopening the window does **not** roll those back — see
 * `reopenBusinessDay`, which reports what was already triggered.
 */
export interface CloseBusinessDayOptions {
  /** A client idempotency key; a replay returns the closure it already wrote. */
  requestId?: string | null;
}

export async function closeBusinessDay(
  locationId: string,
  businessId: string,
  actorId: string | null,
  note: string | null = null,
  options: CloseBusinessDayOptions = {},
): Promise<BusinessDayStatus> {
  const requestId = options.requestId?.trim() || null;
  if (requestId !== null && requestId.length > 200) {
    throw new BusinessDayError("bad_request", 400);
  }

  const client = await getPool().connect();
  let closureId: string | null = null;
  let businessDate: string | null = null;
  try {
    await client.query("BEGIN");
    // Serializes every close/reopen for this branch, in every process. The
    // unique index is the backstop; this is what turns the race into a wait
    // rather than a 23505 the caller has to interpret.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('business_day:' || $1))", [locationId]);

    const status = await readBusinessDayStatus(client, locationId);
    if (!status) throw new BusinessDayError("location_not_found", 404);
    if (!status.enabled) throw new BusinessDayError("business_day_not_configured", 409);
    businessDate = status.businessDate;

    if (requestId) {
      const replay = await client.query<{ id: string }>(
        `SELECT id FROM business_day_closures
          WHERE location_id = $1 AND request_id = $2 AND reopened_at IS NULL`,
        [locationId, requestId],
      );
      if (replay.rows[0]) {
        await client.query("COMMIT");
        return { ...status, closureId: replay.rows[0].id };
      }
    }

    if (status.manuallyClosed) {
      throw new BusinessDayError("business_day_already_closed", 409);
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO business_day_closures
         (business_id, location_id, business_date, closed_by, note, request_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (location_id, business_date) WHERE reopened_at IS NULL DO NOTHING
       RETURNING id`,
      [businessId, locationId, status.businessDate, actorId, note, requestId],
    );
    if (!rows[0]) throw new BusinessDayError("business_day_already_closed", 409);
    closureId = rows[0].id;

    await client.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'business_day.closed', 'business_day', $3, $4)`,
      [
        businessId,
        actorId,
        locationId,
        JSON.stringify({ businessDate: status.businessDate, closureId, note, requestId }),
      ],
    );
    const updated = await readBusinessDayStatus(client, locationId);
    if (!updated) throw new BusinessDayError("location_not_found", 404);
    // Nothing that can fail remains before the commit, so a committed close can
    // never be reported as a failure (#933 item 1's shape, here too).
    await client.query("COMMIT");
    await queueCloseSideEffects(businessId, locationId, status.businessDate, closureId);
    return { ...updated, closureId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if ((error as { code?: string }).code === "23505") {
      throw new BusinessDayError("business_day_already_closed", 409);
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The post-commit half of a close: both producers swallow their own errors, and
 * this wrapper makes sure a failure cannot surface as a failed close. Keyed on
 * the closure id, so a reopened-then-reclosed day is a new event rather than a
 * suppressed duplicate.
 */
async function queueCloseSideEffects(
  businessId: string,
  locationId: string,
  businessDate: string,
  closureId: string,
): Promise<void> {
  try {
      await recordCoworkerEvent({
        businessId,
        locationId,
        kind: "day_close",
        payload: { businessDate, closureId },
        dedupeKey: closureId,
      });
      await recordNotification({
        businessId,
        locationId,
        eventKey: "business_day.closed",
        severity: "info",
        title: "روز کاری بسته شد",
        body: `روز ${toPersianDigits(businessDate)} در این شعبه بسته شد.`,
        url: "/settings/shifts",
        dedupeKey: notificationDedupeKey("business_day.closed", locationId, businessDate),
        payload: { businessDate, closureId },
      });
  } catch (error) {
    console.error("business day close side effects failed:", error instanceof Error ? error.message : error);
  }
}

export interface ReopenBusinessDayOptions {
  /**
   * The exact closure to undo. Omitted means "the closure holding the current
   * window", which is what the panel's single button means. Naming an id is
   * what lets an operator undo a specific row instead of every row that
   * happened to fall inside the scheduled range (the old DELETE).
   */
  closureId?: string | null;
  note?: string | null;
}

/**
 * Undoes a close taken by mistake, putting the live window back to the business
 * day's scheduled start.
 *
 * ## What a reopen does and does not do (#933 item 8)
 *
 * It reopens the *window*. It does not undo what the close already triggered: a
 * `day_close` coworker event may have run, and a report or automation may have
 * consumed the closed day. The row is marked reopened rather than deleted, so
 * history survives, and the returned status lists `reopenEffects` so the panel
 * can say so instead of implying a full rollback.
 */
export async function reopenBusinessDay(
  locationId: string,
  businessId: string,
  actorId: string | null,
  options: ReopenBusinessDayOptions = {},
): Promise<BusinessDayStatus> {
  const closureId = options.closureId && isUuid(options.closureId) ? options.closureId : null;
  if (options.closureId && !closureId) throw new BusinessDayError("closure_not_found", 404);
  const note = options.note?.trim() || null;
  if (note !== null && note.length > 500) throw new BusinessDayError("bad_request", 400);

  const client = await getPool().connect();
  let reopenedId: string | null = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('business_day:' || $1))", [locationId]);

    const status = await readBusinessDayStatus(client, locationId);
    if (!status) throw new BusinessDayError("location_not_found", 404);

    const target = await client.query<{ id: string }>(
      closureId
        ? `SELECT id FROM business_day_closures
            WHERE id = $1 AND location_id = $2 AND business_id = $3 AND reopened_at IS NULL`
        : `SELECT id FROM business_day_closures
            WHERE location_id = $1 AND business_id = $2 AND reopened_at IS NULL
              AND closed_at >= $3 AND closed_at < $4
            ORDER BY closed_at DESC LIMIT 1`,
      closureId
        ? [closureId, locationId, businessId]
        : [locationId, businessId, status.scheduledStart, status.scheduledEnd],
    );
    if (!target.rows[0] || (!closureId && !status.manuallyClosed)) {
      throw new BusinessDayError("business_day_not_closed", 409);
    }
    reopenedId = target.rows[0].id;

    const updated = await client.query(
      `UPDATE business_day_closures
          SET reopened_at = now(), reopened_by = $2, reopen_note = $3
        WHERE id = $1 AND reopened_at IS NULL
        RETURNING id`,
      [reopenedId, actorId, note],
    );
    if (updated.rowCount !== 1) throw new BusinessDayError("business_day_already_reopened", 409);

    await client.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'business_day.reopened', 'business_day', $3, $4)`,
      [
        businessId,
        actorId,
        locationId,
        JSON.stringify({ businessDate: status.businessDate, closureId: reopenedId, note }),
      ],
    );
    const after = await readBusinessDayStatus(client, locationId);
    // Which already-triggered work this reopen leaves in place. The close's
    // own row is the evidence — the note is shown, not acted on.
    const triggered = await client.query<{ kind: string }>(
      `SELECT kind FROM ai_coworker_events
        WHERE business_id = $1 AND kind = 'day_close' AND dedupe_key = $2`,
      [businessId, reopenedId],
    );
    await client.query("COMMIT");
    if (!after) throw new BusinessDayError("location_not_found", 404);
    const effects: string[] = [];
    if (triggered.rows[0]) effects.push("day_close_coworker_event_queued");
    return { ...after, closureId: reopenedId, reopenEffects: effects };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface BusinessDayClosure {
  id: string;
  businessDate: string;
  closedAt: string;
  closedByName: string | null;
  note: string | null;
  reopenedAt: string | null;
  reopenedByName: string | null;
  reopenNote: string | null;
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
    reopened_at: Date | null;
    reopened_by_name: string | null;
    reopen_note: string | null;
  }>(
    `SELECT c.id, c.business_date, c.closed_at, u.full_name AS closed_by_name, c.note,
            c.reopened_at, ru.full_name AS reopened_by_name, c.reopen_note
       FROM business_day_closures c
       LEFT JOIN users u ON u.id = c.closed_by
       LEFT JOIN users ru ON ru.id = c.reopened_by
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
    reopenedAt: row.reopened_at ? row.reopened_at.toISOString() : null,
    reopenedByName: row.reopened_by_name,
    reopenNote: row.reopen_note,
  }));
}


/**
 * The branch a business-wide «today» is taken from, and the day it is keeping.
 *
 * Every business-wide reader — the CRM queues, the queue cards' own «دیدن همه»
 * links, the cross-server rollup — has a business but no branch in hand, and
 * each of them is really asking *what day is it here*. Answering that with a
 * bare date was half an answer, and the missing half is what this carries: a
 * date is only a day once you say where it begins. The branch's timezone (and,
 * for a branch that configured one, its business-day start) decides that — not
 * the database session's timezone, which is UTC on a server and therefore
 * already tomorrow for three and a half hours of every Tehran evening.
 *
 * So a reader that compares timestamps against «today» takes the whole context
 * and does the comparison in the shop's own zone (`crm-queues.ts`,
 * `crm-service.listActivities`), while a reader that only needs to print the
 * date keeps calling `businessToday`.
 */
export interface BusinessDayContext {
  /** The branch the day was taken from; null when the business has no active branch. */
  locationId: string | null;
  /** That branch's zone, or `Asia/Tehran` for the fallback. */
  timeZone: string;
  /** Minutes after local midnight, or null when it runs calendar days. */
  startMinutes: number | null;
  /** The trading day in progress there, as an ISO date. */
  businessDate: string;
}

/**
 * The business's current business day, from its primary active branch — the
 * business-wide counterpart of `getBusinessDayStatus`, for the callers that
 * have a business but no particular branch in hand.
 *
 * "Primary" is the oldest active branch, which is the same branch the rollup
 * has always taken its timezone from; a business whose branches keep different
 * hours gets that one's trading day, exactly as it already got that one's
 * timezone. Falls back to Asia/Tehran and the calendar day when a business has
 * no active branch at all, so a caller always gets a usable day.
 */
export async function businessDayContext(businessId: string): Promise<BusinessDayContext> {
  const { rows } = await query<{
    location_id: string | null;
    timezone: string;
    business_day_start_minutes: number | null;
    today: string;
  }>(
    `SELECT l.id AS location_id,
            coalesce(l.timezone, 'Asia/Tehran') AS timezone,
            l.business_day_start_minutes,
            app_business_date(
              now(),
              coalesce(l.timezone, 'Asia/Tehran'),
              l.business_day_start_minutes
            )::text AS today
       FROM (SELECT 1) one
       LEFT JOIN LATERAL (
         SELECT id, timezone, business_day_start_minutes
           FROM locations
          WHERE business_id = $1 AND is_active
          ORDER BY created_at
          LIMIT 1
       ) l ON true`,
    [businessId],
  );
  const row = rows[0];
  return {
    locationId: row.location_id,
    timeZone: row.timezone,
    startMinutes: row.business_day_start_minutes,
    businessDate: row.today,
  };
}

/**
 * The business day in progress, as a date — the date half of the context above,
 * for the callers that print it rather than compare against it.
 */
export async function businessToday(businessId: string): Promise<string> {
  return (await businessDayContext(businessId)).businessDate;
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
 *
 * The zone half of `businessDayContext`, which reads the same branch in the
 * same query — a caller that needs the start of the day as well (`app_business_date`
 * buckets by zone *and* `business_day_start_minutes`, so a branch trading
 * 18:00→03:00 has a day boundary this zone alone does not describe) takes the
 * whole context rather than pairing this with a second read of `locations`.
 */
export async function businessTimeZone(businessId: string): Promise<string> {
  return (await businessDayContext(businessId)).timeZone;
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
