/**
 * Scheduled exports — «فروش روزانه»، «مشتریان هفتگی»، «حسابداری ماهانه».
 *
 * ## How the schedule is claimed
 *
 * The tick moves `next_run_at` forward **before** it produces anything, with a
 * conditional UPDATE that only matches a row still due. Two app instances
 * ticking in the same second therefore produce one export rather than two:
 * the second one's WHERE no longer matches. That is the same claim-then-perform
 * shape the notification outbox uses, and it is the only thing standing between
 * a two-instance deployment and duplicate emails every morning.
 *
 * ## Why the hour is local
 *
 * "Every morning at seven" is a statement about the shop's morning. The hour is
 * stored as 0–23 in the business's own timezone (`locations.timezone`, Tehran
 * by default) and resolved against that zone here, so a deployment that moves
 * region does not silently start emailing at four in the afternoon.
 *
 * ## Delivery
 *
 * Two independent switches, both may be on. `deliver_store` keeps the file in
 * the export history so it is downloadable from the screen; `deliver_email`
 * attaches it to a mail through the platform's existing SMTP provider. There
 * is no third "upload it somewhere" option, because the deployment has exactly
 * one storage integration and it is the one the history already uses.
 */

import { query, withoutTenantScope, withTenant } from "../db";
import { resolveMessageConfig } from "../messaging-billing";
import { SmtpMessageProvider } from "../messaging/providers/smtp";
import { toPersianDigits } from "../digits";
import { formatJalali } from "../jalali";
import { findEntity } from "./registry";
import { memberAccessForUser } from "../member-access";
import { partyReadAudienceForPermissions } from "../personnel-access";
import { createExportJob } from "./export-service";
import { recordDataTransferAudit } from "./audit";
import type { ExportFormat, ScheduleFrequency } from "./types";

export const SCHEDULED_EXPORT_TICK_INTERVAL_MS = 5 * 60_000;

export class ScheduleError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ScheduleError";
  }
}

export interface ScheduledExport {
  id: string;
  entityKey: string;
  entityLabel: string;
  name: string;
  format: ExportFormat;
  frequency: ScheduleFrequency;
  hourLocal: number;
  weekday: number | null;
  dayOfMonth: number | null;
  fields: string[];
  filters: Record<string, unknown>;
  deliverEmail: string;
  deliverStore: boolean;
  isActive: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: "completed" | "failed" | null;
  lastError: string | null;
  createdAt: string;
}

interface ScheduleRow extends Record<string, unknown> {
  id: string;
  entity_key: string;
  name: string;
  format: ExportFormat;
  frequency: ScheduleFrequency;
  hour_local: number;
  weekday: number | null;
  day_of_month: number | null;
  fields: unknown;
  filters: unknown;
  deliver_email: string;
  deliver_store: boolean;
  is_active: boolean;
  next_run_at: Date;
  last_run_at: Date | null;
  last_status: "completed" | "failed" | null;
  last_error: string | null;
  created_at: Date;
}

const COLUMNS = `id, entity_key, name, format, frequency, hour_local, weekday, day_of_month,
  fields, filters, deliver_email, deliver_store, is_active, next_run_at, last_run_at,
  last_status, last_error, created_at`;

function toSchedule(row: ScheduleRow): ScheduledExport {
  return {
    id: row.id,
    entityKey: row.entity_key,
    entityLabel: findEntity(row.entity_key)?.label ?? row.entity_key,
    name: row.name,
    format: row.format,
    frequency: row.frequency,
    hourLocal: row.hour_local,
    weekday: row.weekday,
    dayOfMonth: row.day_of_month,
    fields: Array.isArray(row.fields) ? (row.fields as string[]) : [],
    filters: (row.filters ?? {}) as Record<string, unknown>,
    deliverEmail: row.deliver_email,
    deliverStore: row.deliver_store,
    isActive: row.is_active,
    nextRunAt: row.next_run_at.toISOString(),
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastStatus: row.last_status,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The next instant a schedule is due, as a UTC Date.
 *
 * Pure and exported so the rule is unit-testable without a clock or a
 * database: given "weekly, Saturday, 07:00, Asia/Tehran" and a moment, it
 * answers the next Saturday 07:00 Tehran after that moment.
 *
 * `weekday` is 0 = شنبه … 6 = جمعه, the Persian week. JavaScript's
 * `getUTCDay()` is 0 = Sunday, so the two are related by `(js + 1) % 7`.
 */
export function nextRunAt(
  schedule: {
    frequency: ScheduleFrequency;
    hourLocal: number;
    weekday?: number | null;
    dayOfMonth?: number | null;
  },
  after: Date,
  timeZone = "Asia/Tehran",
): Date {
  const offsetMs = timeZoneOffsetMs(after, timeZone);
  // Work in "local" milliseconds — the wall clock of the business's zone
  // expressed as a UTC instant — then shift back at the end. Doing the
  // calendar arithmetic in the target zone is the only way "the 31st" and
  // "Saturday" mean what the operator meant.
  const local = new Date(after.getTime() + offsetMs);

  const candidate = new Date(local.getTime());
  candidate.setUTCHours(schedule.hourLocal, 0, 0, 0);

  if (schedule.frequency === "daily") {
    if (candidate.getTime() <= local.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return new Date(candidate.getTime() - timeZoneOffsetMs(candidate, timeZone));
  }

  if (schedule.frequency === "weekly") {
    const target = clampWeekday(schedule.weekday);
    for (let i = 0; i < 8; i += 1) {
      const probe = new Date(candidate.getTime());
      probe.setUTCDate(candidate.getUTCDate() + i);
      if (persianWeekday(probe) !== target) continue;
      if (probe.getTime() <= local.getTime()) continue;
      return new Date(probe.getTime() - timeZoneOffsetMs(probe, timeZone));
    }
    // Unreachable in practice; a week always contains the target day.
    candidate.setUTCDate(candidate.getUTCDate() + 7);
    return new Date(candidate.getTime() - timeZoneOffsetMs(candidate, timeZone));
  }

  // Monthly. The day is clamped to the month's length, so "the 31st" in a
  // 30-day month is the 30th rather than silently the 1st of the next one.
  const day = Math.min(Math.max(schedule.dayOfMonth ?? 1, 1), 31);
  for (let i = 0; i < 3; i += 1) {
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() + i;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const probe = new Date(
      Date.UTC(year, month, Math.min(day, lastDay), schedule.hourLocal, 0, 0, 0),
    );
    if (probe.getTime() > local.getTime()) {
      return new Date(probe.getTime() - timeZoneOffsetMs(probe, timeZone));
    }
  }
  const fallback = new Date(local.getTime());
  fallback.setUTCMonth(fallback.getUTCMonth() + 1);
  return new Date(fallback.getTime() - timeZoneOffsetMs(fallback, timeZone));
}

function clampWeekday(value: number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 0;
}

/** 0 = شنبه … 6 = جمعه, from a Date read in UTC terms. */
function persianWeekday(date: Date): number {
  return (date.getUTCDay() + 1) % 7;
}

/** The zone's offset from UTC at that instant, in milliseconds. */
function timeZoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - at.getTime();
}

async function timeZoneFor(businessId: string): Promise<string> {
  const { rows } = await query<{ timezone: string }>(
    `SELECT timezone FROM locations WHERE business_id = $1 AND is_active
      ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  return rows[0]?.timezone || "Asia/Tehran";
}

export async function listScheduledExports(businessId: string): Promise<ScheduledExport[]> {
  const { rows } = await query<ScheduleRow>(
    `SELECT ${COLUMNS} FROM data_scheduled_exports WHERE business_id = $1 ORDER BY name`,
    [businessId],
  );
  return rows.map(toSchedule);
}

export interface SaveScheduleInput {
  businessId: string;
  locationId: string | null;
  entityKey: string;
  name: string;
  format: ExportFormat;
  frequency: ScheduleFrequency;
  hourLocal: number;
  weekday?: number | null;
  dayOfMonth?: number | null;
  fields?: readonly string[];
  filters?: Record<string, unknown>;
  deliverEmail?: string;
  deliverStore?: boolean;
  actorUserId: string | null;
}

export async function createScheduledExport(
  input: SaveScheduleInput,
): Promise<ScheduledExport> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new ScheduleError("name_required");
  if (!findEntity(input.entityKey)) throw new ScheduleError("unknown_entity");
  const email = (input.deliverEmail ?? "").trim();
  const store = input.deliverStore !== false;
  if (!email && !store) throw new ScheduleError("no_delivery");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ScheduleError("invalid_email");

  const timeZone = await timeZoneFor(input.businessId);
  const due = nextRunAt(
    {
      frequency: input.frequency,
      hourLocal: input.hourLocal,
      weekday: input.weekday,
      dayOfMonth: input.dayOfMonth,
    },
    new Date(),
    timeZone,
  );

  try {
    const { rows } = await query<ScheduleRow>(
      `INSERT INTO data_scheduled_exports
         (business_id, location_id, entity_key, name, format, frequency, hour_local,
          weekday, day_of_month, fields, filters, deliver_email, deliver_store,
          next_run_at, created_by)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13,
               $14, $15::uuid)
       RETURNING ${COLUMNS}`,
      [
        input.businessId,
        input.locationId,
        input.entityKey,
        name,
        input.format,
        input.frequency,
        Math.min(Math.max(Math.trunc(input.hourLocal), 0), 23),
        input.frequency === "weekly" ? clampWeekday(input.weekday) : null,
        input.frequency === "monthly"
          ? Math.min(Math.max(Math.trunc(input.dayOfMonth ?? 1), 1), 31)
          : null,
        JSON.stringify([...(input.fields ?? [])]),
        JSON.stringify(input.filters ?? {}),
        email,
        store,
        due,
        input.actorUserId,
      ],
    );
    return toSchedule(rows[0]);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "23505") {
      throw new ScheduleError("name_taken");
    }
    throw error;
  }
}

export async function updateScheduledExport(
  businessId: string,
  id: string,
  patch: Partial<Omit<SaveScheduleInput, "businessId" | "entityKey" | "actorUserId">> & {
    isActive?: boolean;
  },
): Promise<ScheduledExport | null> {
  const current = await query<ScheduleRow>(
    `SELECT ${COLUMNS} FROM data_scheduled_exports WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  if (!current.rows[0]) return null;
  const existing = toSchedule(current.rows[0]);

  const sets = ["updated_at = now()"];
  const params: unknown[] = [businessId, id];
  const add = (column: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };

  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 120);
    if (!name) throw new ScheduleError("name_required");
    add("name", name);
  }
  if (patch.format !== undefined) add("format", patch.format);
  if (patch.fields !== undefined) add("fields", JSON.stringify([...patch.fields]), "::jsonb");
  if (patch.filters !== undefined) add("filters", JSON.stringify(patch.filters), "::jsonb");
  if (patch.deliverEmail !== undefined) {
    const email = patch.deliverEmail.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ScheduleError("invalid_email");
    }
    add("deliver_email", email);
  }
  if (patch.deliverStore !== undefined) add("deliver_store", patch.deliverStore);
  if (patch.isActive !== undefined) add("is_active", patch.isActive);

  const timingChanged =
    patch.frequency !== undefined ||
    patch.hourLocal !== undefined ||
    patch.weekday !== undefined ||
    patch.dayOfMonth !== undefined;

  if (timingChanged) {
    const frequency = patch.frequency ?? existing.frequency;
    const hourLocal = patch.hourLocal ?? existing.hourLocal;
    const weekday = patch.weekday ?? existing.weekday;
    const dayOfMonth = patch.dayOfMonth ?? existing.dayOfMonth;
    add("frequency", frequency);
    add("hour_local", Math.min(Math.max(Math.trunc(hourLocal), 0), 23));
    add("weekday", frequency === "weekly" ? clampWeekday(weekday) : null);
    add(
      "day_of_month",
      frequency === "monthly" ? Math.min(Math.max(Math.trunc(dayOfMonth ?? 1), 1), 31) : null,
    );
    const timeZone = await timeZoneFor(businessId);
    add(
      "next_run_at",
      nextRunAt({ frequency, hourLocal, weekday, dayOfMonth }, new Date(), timeZone),
    );
  }

  try {
    const { rows } = await query<ScheduleRow>(
      `UPDATE data_scheduled_exports SET ${sets.join(", ")}
        WHERE business_id = $1 AND id = $2
        RETURNING ${COLUMNS}`,
      params,
    );
    return rows[0] ? toSchedule(rows[0]) : null;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "23505") {
      throw new ScheduleError("name_taken");
    }
    throw error;
  }
}

export async function deleteScheduledExport(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM data_scheduled_exports WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Produce one schedule's export now, store it, and email it if configured.
 *
 * Exported separately from the tick so «اجرای دستی» on the screen and the
 * scheduler run exactly the same code — a "run now" that took a different path
 * would test nothing about the scheduled one.
 */
export async function runScheduledExport(
  businessId: string,
  scheduleId: string,
): Promise<{ exportJobId: string; emailed: boolean; rowCount: number }> {
  const { rows } = await query<ScheduleRow & { location_id: string | null; created_by: string | null }>(
    `SELECT ${COLUMNS}, location_id, created_by FROM data_scheduled_exports
      WHERE business_id = $1 AND id = $2`,
    [businessId, scheduleId],
  );
  if (!rows[0]) throw new ScheduleError("schedule_not_found");
  const schedule = toSchedule(rows[0]);
  const locationId = rows[0].location_id;

  /*
   * Issue #947 (TEAM-F01) — a schedule runs with no member behind it, so the audience
   * comes from the member who created it: a manager's nightly customer file must not
   * quietly accumulate the personnel columns the manager cannot see on screen, while an
   * owner's keeps all of them. An unresolvable creator (the member was deleted, the
   * membership revoked) narrows rather than widens — «we no longer know who this runs
   * for» must not read as «it may read everything».
   */
  const creator = rows[0].created_by
    ? await memberAccessForUser(businessId, rows[0].created_by)
    : null;

  const { job, body } = await createExportJob({
    businessId,
    locationId,
    entityKey: schedule.entityKey,
    format: schedule.format,
    fields: schedule.fields,
    filters: schedule.filters,
    actorUserId: null,
    actorName: `زمان‌بندی «${schedule.name}»`,
    scheduleId: schedule.id,
    partyAudience: partyReadAudienceForPermissions(creator?.isActive ? creator.permissions : null),
  });

  // `deliver_store: false` means "email it and do not keep a copy" — a
  // reasonable choice for a customer list. The history row stays either way.
  if (!schedule.deliverStore) {
    await query(`UPDATE data_export_jobs SET content = NULL WHERE business_id = $1 AND id = $2`, [
      businessId,
      job.id,
    ]);
  }

  let emailed = false;
  if (schedule.deliverEmail) {
    emailed = await emailExport(schedule, job.fileName, job.contentType, body, job.rowCount);
  }

  await recordDataTransferAudit({
    businessId,
    action: "data.export.scheduled",
    entityKey: schedule.entityKey,
    entityId: job.id,
    actorUserId: null,
    payload: {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      rowCount: job.rowCount,
      emailed,
    },
  });

  return { exportJobId: job.id, emailed, rowCount: job.rowCount };
}

async function emailExport(
  schedule: ScheduledExport,
  fileName: string,
  contentType: string,
  body: Buffer,
  rowCount: number,
): Promise<boolean> {
  const config = await resolveMessageConfig();
  if (!config.enabled || config.emailProvider !== "smtp" || !config.smtp) return false;
  const provider = new SmtpMessageProvider({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    user: config.smtp.user,
    password: config.smtp.password ?? "",
    from: config.smtp.from,
  });
  const today = toPersianDigits(formatJalali(new Date(), { withMonthName: true }));
  const result = await provider.send({
    to: schedule.deliverEmail,
    subject: `${schedule.name} — ${today}`,
    body: [
      `خروجی زمان‌بندی‌شدهٔ «${schedule.name}» آمادهٔ استفاده است.`,
      "",
      `موضوع: ${schedule.entityLabel}`,
      `تعداد رکورد: ${toPersianDigits(rowCount)}`,
      `تاریخ: ${today}`,
      "",
      "فایل خروجی پیوست همین ایمیل است.",
    ].join("\n"),
    attachments: [{ filename: fileName, content: body, contentType }],
  });
  return result.ok;
}

/**
 * The scheduler tick.
 *
 * Enumerates due schedules under the documented platform bypass — there is no
 * session to derive a tenant from — and re-enters each business with
 * `withTenant` before producing anything, the same shape every other
 * background tick in `server.ts` uses. One business's failure never stops the
 * next one's.
 */
export async function runScheduledExportsTick(): Promise<number> {
  const due = await withoutTenantScope("platform", async () => {
    // The claim: move next_run_at forward first, so a second instance running
    // the same second finds nothing due. The new value is recomputed properly
    // per-business below; this provisional +1h is only a lock, and a failure
    // path that never reached the recompute would simply retry in an hour
    // rather than spin.
    const { rows } = await query<{
      id: string;
      business_id: string;
      frequency: ScheduleFrequency;
      hour_local: number;
      weekday: number | null;
      day_of_month: number | null;
    }>(
      `UPDATE data_scheduled_exports
          SET next_run_at = next_run_at + interval '1 hour', updated_at = now()
        WHERE id IN (
          SELECT id FROM data_scheduled_exports
           WHERE is_active AND next_run_at <= now()
           ORDER BY next_run_at
           FOR UPDATE SKIP LOCKED
           LIMIT 20
        )
        RETURNING id, business_id, frequency, hour_local, weekday, day_of_month`,
    );
    return rows;
  });

  let ran = 0;
  for (const schedule of due) {
    await withTenant(schedule.business_id, async () => {
      try {
        await runScheduledExport(schedule.business_id, schedule.id);
        await markScheduleRun(schedule, "completed", null);
        ran += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 300) : "unknown";
        await markScheduleRun(schedule, "failed", message);
        console.error("scheduled export failed", schedule.id, error);
      }
    });
  }
  return ran;
}

async function markScheduleRun(
  schedule: {
    id: string;
    business_id: string;
    frequency: ScheduleFrequency;
    hour_local: number;
    weekday: number | null;
    day_of_month: number | null;
  },
  status: "completed" | "failed",
  error: string | null,
): Promise<void> {
  const timeZone = await timeZoneFor(schedule.business_id);
  const next = nextRunAt(
    {
      frequency: schedule.frequency,
      hourLocal: schedule.hour_local,
      weekday: schedule.weekday,
      dayOfMonth: schedule.day_of_month,
    },
    new Date(),
    timeZone,
  );
  await query(
    `UPDATE data_scheduled_exports
        SET last_run_at = now(), last_status = $3, last_error = $4,
            next_run_at = $5, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [schedule.business_id, schedule.id, status, error, next],
  );
}
