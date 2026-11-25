import type { PoolClient } from "pg";
import { query } from "./db";

export type KitchenWorkflow = "kitchen_team" | "manage_from_orders" | "ready_on_send";

/**
 * Anything that can run SQL on the branch's tenant connection — the pooled
 * `query` helper (`{ query }`) or a transaction client. The pool helper is a
 * free function, so it cannot satisfy `Pick<PoolClient, "query">`; the routes
 * that have no transaction pass `{ query }`.
 */
export type KitchenSqlRunner = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export function isKitchenWorkflow(value: unknown): value is KitchenWorkflow {
  return value === "kitchen_team" || value === "manage_from_orders" || value === "ready_on_send";
}

export async function getKitchenWorkflow(
  businessId: string,
  locationId: string,
  client?: Pick<PoolClient, "query">,
): Promise<KitchenWorkflow> {
  const sql = "SELECT value FROM settings WHERE business_id = $1 AND location_id = $2 AND key = 'kitchen.workflow'";
  const result = client
    ? await client.query<{ value: unknown }>(sql, [businessId, locationId])
    : await query<{ value: unknown }>(sql, [businessId, locationId]);
  const value = result.rows[0]?.value;
  return isKitchenWorkflow(value) ? value : "kitchen_team";
}

/** Caller owns the order lock so payment and the final ready item converge. */
export async function archivePaidKitchenTicket(
  client: Pick<PoolClient, "query">,
  locationId: string,
  orderId: string,
): Promise<void> {
  await client.query(
    `UPDATE order_items oi
        SET kitchen_archived_at = now(), kitchen_archive_reason = 'paid'
       FROM orders o JOIN locations l ON l.id = o.location_id
      WHERE o.id = $2 AND o.location_id = $1 AND oi.location_id = l.id
        AND oi.order_id = o.id AND oi.status = 'ready' AND oi.kitchen_archived_at IS NULL
        AND (oi.kitchen_clear_at IS NULL OR oi.kitchen_clear_at > now())
        AND o.status = 'completed'
        AND (o.website_approval_state IS NULL OR o.website_approval_state = 'accepted')
        AND EXISTS (
          SELECT 1 FROM settings s WHERE s.business_id = l.business_id
            AND s.location_id = l.id AND s.key = 'kitchen.clearAfterPayment' AND s.value = 'true'::jsonb
        )
        AND NOT EXISTS (
          SELECT 1 FROM order_items other WHERE other.order_id = o.id AND other.location_id = l.id
            AND other.status IN ('pending', 'sent', 'preparing') AND other.kitchen_archived_at IS NULL
            AND (other.kitchen_clear_at IS NULL OR other.kitchen_clear_at > now())
        )
        AND COALESCE((
          SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id
           AND p.location_id = l.id AND p.method <> 'credit'
        ), 0) >= o.total + COALESCE(o.tip_amount, 0)`,
    [locationId, orderId],
  );
}

/** Store the deadline on the ticket lines so clearing needs no running display. */
export async function scheduleKitchenTicket(
  client: Pick<PoolClient, "query">,
  locationId: string,
  orderId: string,
): Promise<void> {
  await client.query(
    `WITH ticket AS (
       SELECT oi.order_id, MAX(oi.ready_at) AS ready_at
         FROM order_items oi
        WHERE oi.order_id = $2 AND oi.location_id = $1
          AND oi.status IN ('pending', 'sent', 'preparing', 'ready')
          AND oi.kitchen_archived_at IS NULL
          AND (oi.kitchen_clear_at IS NULL OR oi.kitchen_clear_at > now())
        GROUP BY oi.order_id
       HAVING bool_and(oi.status = 'ready' AND oi.ready_at IS NOT NULL)
     )
     UPDATE order_items oi
        SET kitchen_clear_at = CASE WHEN ticket.ready_at IS NOT NULL
          AND s.value::text ~ '^[0-9]{1,4}$' THEN
          ticket.ready_at + make_interval(mins => s.value::text::int)
          ELSE NULL END
       FROM locations l
       LEFT JOIN ticket ON true
       LEFT JOIN settings s ON s.business_id = l.business_id
        AND s.location_id = l.id AND s.key = 'kitchen.clearAfterMinutes'
      WHERE l.id = $1 AND oi.location_id = l.id AND oi.order_id = $2
        AND oi.status = 'ready' AND oi.kitchen_archived_at IS NULL
        AND (oi.kitchen_clear_at IS NULL OR oi.kitchen_clear_at > now())`,
    [locationId, orderId],
  );
}

export async function archiveShiftKitchenTickets(
  client: Pick<PoolClient, "query">,
  shift: { businessId: string; locationId: string; employeeId: string; startedAt: string; endedAt: string },
): Promise<void> {
  const { rows: settings } = await client.query<{ value: unknown }>(
    `SELECT value FROM settings WHERE business_id = $1 AND location_id = $2
       AND key = 'kitchen.clearAfterShift'`,
    [shift.businessId, shift.locationId],
  );
  if (settings[0]?.value !== true) return;
  const orders = await client.query<{ id: string }>(
    `SELECT o.id FROM orders o
      WHERE o.location_id = $1 AND o.opened_by = $2
        AND o.opened_at >= $3 AND o.opened_at < $4
        AND o.status IN ('open', 'held', 'completed')
        AND (o.website_approval_state IS NULL OR o.website_approval_state = 'accepted')
        AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.location_id = o.location_id
          AND oi.order_id = o.id AND oi.status = 'ready' AND oi.kitchen_archived_at IS NULL)
      ORDER BY o.id FOR UPDATE`,
    [shift.locationId, shift.employeeId, shift.startedAt, shift.endedAt],
  );
  if (!orders.rows.length) return;
  await client.query(
    `UPDATE order_items oi
        SET kitchen_archived_at = $3, kitchen_archive_reason = 'shift'
      WHERE oi.location_id = $1 AND oi.order_id = ANY($2::uuid[])
        AND oi.status = 'ready' AND oi.ready_at <= $3 AND oi.kitchen_archived_at IS NULL
        AND (oi.kitchen_clear_at IS NULL OR oi.kitchen_clear_at > $3)
        AND NOT EXISTS (
          SELECT 1 FROM order_items other WHERE other.order_id = oi.order_id
            AND other.location_id = oi.location_id AND other.kitchen_archived_at IS NULL
            AND (other.kitchen_clear_at IS NULL OR other.kitchen_clear_at > $3)
            AND (other.status IN ('pending', 'sent', 'preparing')
              OR (other.status = 'ready' AND (other.ready_at IS NULL OR other.ready_at > $3)))
        )`,
    [shift.locationId, orders.rows.map((row) => row.id), shift.endedAt],
  );
}

export async function previewShiftKitchenClose(shift: {
  businessId: string; locationId: string; employeeId: string; startedAt: string;
}): Promise<{ ready: number; unfinished: number; balanceDue: number } | null> {
  const { rows: settings } = await query<{ value: unknown }>(
    "SELECT value FROM settings WHERE business_id = $1 AND location_id = $2 AND key = 'kitchen.clearAfterShift'",
    [shift.businessId, shift.locationId],
  );
  if (settings[0]?.value !== true) return null;
  const { rows } = await query<{ ready: number; unfinished: number; balanceDue: number }>(
    `WITH visible AS (
       SELECT o.id,
              bool_and(oi.status = 'ready' AND oi.ready_at IS NOT NULL) AS ready,
              o.total + COALESCE(o.tip_amount, 0) > COALESCE((
                SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id
                  AND p.location_id = o.location_id AND p.method <> 'credit'
              ), 0) AS due
         FROM orders o JOIN order_items oi ON oi.order_id = o.id AND oi.location_id = o.location_id
        WHERE o.location_id = $1 AND o.opened_by = $2 AND o.opened_at >= $3
          AND o.opened_at < now() AND o.status IN ('open', 'held', 'completed')
          AND (o.website_approval_state IS NULL OR o.website_approval_state = 'accepted')
          AND oi.status IN ('pending', 'sent', 'preparing', 'ready')
          AND oi.kitchen_archived_at IS NULL AND (oi.kitchen_clear_at IS NULL OR oi.kitchen_clear_at > now())
        GROUP BY o.id
     )
     SELECT COUNT(*) FILTER (WHERE ready)::int AS ready,
            COUNT(*) FILTER (WHERE NOT ready)::int AS unfinished,
            COUNT(*) FILTER (WHERE due)::int AS "balanceDue" FROM visible`,
    [shift.locationId, shift.employeeId, shift.startedAt],
  );
  return rows[0] ?? null;
}

/**
 * Every kitchen ticket whose business day has passed leaves the board on its
 * own — «سفارشی که از روز کاری خود عبور کرده باشد بایگانی می‌شود».
 *
 * The kitchen queue is a *today* surface: a ticket still sitting there from a
 * previous business date is work nobody closed out, and keeping it on the
 * board past the day it belonged to only buries today's tickets under
 * yesterday's. So the archive is automatic and unconditional — there is no
 * manual «بررسی سفارش‌های قدیمی» pass any more, and nothing to decide per
 * order. Order status and payment are untouched; this only removes the lines
 * from the kitchen display, exactly like the paid/timer/shift exits do.
 *
 * "Crossed the business day" is the branch's own definition of a day
 * (`app_business_date`, migration 0076): a branch whose day starts at 18:00
 * rolls its board over at 18:00, a branch without the setting rolls it over
 * at local midnight. The branch's timezone lives on the row, so the statement
 * reads it from `locations` rather than taking it as a parameter.
 *
 * Callers run this at the two moments a day actually turns over — a business
 * day close, and every read of the queue (which catches the rollover that
 * happens on its own when nobody closes the day). Idempotent: already
 * archived lines and past-day lines of *today's* date are excluded, so a
 * repeated call on the same instant archives nothing extra.
 */
export async function archiveKitchenTicketsPastBusinessDay(
  runner: KitchenSqlRunner,
  locationId: string,
): Promise<number> {
  const { rows } = await runner.query<{ count: number }>(
    `WITH archived AS (
       UPDATE order_items oi
          SET kitchen_archived_at = now(),
              kitchen_archive_reason = 'business_day'
         FROM locations l
        WHERE l.id = $1
          AND oi.location_id = l.id
          AND oi.status IN ('sent', 'preparing', 'ready')
          AND oi.kitchen_archived_at IS NULL
          AND oi.sent_to_kitchen_at IS NOT NULL
          AND app_business_date(oi.sent_to_kitchen_at, l.timezone, l.business_day_start_minutes)
            < app_business_date(now(), l.timezone, l.business_day_start_minutes)
          AND EXISTS (
            SELECT 1 FROM orders o
             WHERE o.id = oi.order_id AND o.location_id = oi.location_id
               AND o.status IN ('open', 'held', 'completed')
               AND (o.website_approval_state IS NULL OR o.website_approval_state = 'accepted')
          )
       RETURNING oi.order_id
     )
     SELECT COUNT(DISTINCT order_id)::int AS count FROM archived`,
    [locationId],
  );
  return rows[0]?.count ?? 0;
}
