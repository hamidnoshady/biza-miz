/**
 * Server half of the kitchen alert policy: load/save the branch thresholds,
 * enqueue the shared notification events, and scan for aged tickets.
 *
 * The scan is here (rather than on every KDS) because "a ticket crossed its
 * threshold" becomes true by time passing, not by a write. It uses the same
 * `recordNotification` outbox as every other producer, so delivery, role ACLs,
 * quiet hours and duplicate suppression stay in the shared engine.
 */
import { createHash } from "node:crypto";
import { query } from "./db";
import { toPersianDigits } from "./digits";
import { notificationDedupeKey } from "./notifications";
import { recordNotification } from "./notification-events";
import { ticketAgeMinutes } from "./order-item-status";
import {
  DEFAULT_KITCHEN_ALERT_THRESHOLDS,
  kitchenAgingStage,
  parseKitchenAlertThresholds,
  resolveKitchenAlertThresholds,
  type KitchenAlertThresholds,
} from "./kitchen-alerts";

type Queryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};
const SETTINGS_KEY = "kitchen.alerts";

/** One page load / scan cannot flood the inbox from a backlog. */
export const MAX_KITCHEN_AGING_ALERTS_PER_SCAN = 20;
const MAX_KITCHEN_AGING_ROWS = 200;

export interface KitchenAlertSettingLayers {
  defaults: KitchenAlertThresholds | null;
  overrides: KitchenAlertThresholds | null;
  effective: KitchenAlertThresholds;
}

/**
 * Read the two layers the print behaviour uses too: a business default
 * (`location_id IS NULL`) and a branch override. The KDS only edits its own
 * branch, but a future owner-wide default needs no new storage shape.
 */
export async function loadKitchenAlertThresholds(
  businessId: string,
  locationId: string,
  client?: Queryable,
): Promise<KitchenAlertSettingLayers> {
  const sql = `SELECT location_id, value FROM settings
     WHERE business_id = $1 AND key = $2 AND (location_id = $3 OR location_id IS NULL)`;
  const params = [businessId, SETTINGS_KEY, locationId];
  const { rows } = client
    ? await client.query<{ location_id: string | null; value: unknown }>(sql, params)
    : await query<{ location_id: string | null; value: unknown }>(sql, params);
  const defaults = parseKitchenAlertThresholds(
    rows.find((row) => row.location_id === null)?.value,
  );
  const overrides = parseKitchenAlertThresholds(
    rows.find((row) => row.location_id === locationId)?.value,
  );
  return {
    defaults,
    overrides,
    effective: resolveKitchenAlertThresholds(defaults, overrides),
  };
}

export async function saveKitchenAlertThresholds(
  client: Queryable,
  input: {
    businessId: string;
    locationId: string;
    thresholds: KitchenAlertThresholds;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (business_id, location_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [input.businessId, input.locationId, SETTINGS_KEY, JSON.stringify(input.thresholds)],
  );
}

/** Effective threshold for each active branch of one business, for the scan. */
async function kitchenAlertThresholdsByLocation(
  businessId: string,
): Promise<{ byLocation: Map<string, KitchenAlertThresholds>; fallback: KitchenAlertThresholds }> {
  const { rows } = await query<{ location_id: string | null; value: unknown }>(
    `SELECT location_id, value FROM settings WHERE business_id = $1 AND key = $2`,
    [businessId, SETTINGS_KEY],
  );
  const defaults = parseKitchenAlertThresholds(
    rows.find((row) => row.location_id === null)?.value,
  );
  const byLocation = new Map<string, KitchenAlertThresholds>();
  for (const row of rows) {
    if (!row.location_id) continue;
    const parsed = parseKitchenAlertThresholds(row.value);
    if (parsed) byLocation.set(row.location_id, parsed);
  }
  return {
    byLocation,
    fallback: defaults ?? DEFAULT_KITCHEN_ALERT_THRESHOLDS,
  };
}

function itemSummary(items: readonly { name: string; quantity: number }[], max = 3): string {
  const shown = items.slice(0, max);
  const parts = shown.map((item) => `${toPersianDigits(item.quantity)}× ${item.name}`);
  const remaining = items.length - shown.length;
  return `${parts.join("، ")}${remaining > 0 ? ` و ${toPersianDigits(remaining)} قلم دیگر` : ""}`;
}

function itemSetDigest(itemIds: readonly string[]): string {
  const canonical = [...new Set(itemIds)].sort();
  return createHash("sha256").update(canonical.join("\n")).digest("hex").slice(0, 32);
}

/**
 * A new order reached the kitchen. `dedupeKey` names the order, so an HTTP
 * retry, an offline replay or a duplicate realtime event cannot notify twice.
 */
export async function recordKitchenTicketCreated(input: {
  businessId: string;
  locationId: string;
  orderId: string;
  orderNumber: number;
  items: readonly { name: string; quantity: number }[];
  itemIds: readonly string[];
}): Promise<boolean> {
  if (input.itemIds.length === 0) return false;
  return recordNotification({
    businessId: input.businessId,
    locationId: input.locationId,
    eventKey: "kitchen.ticket_created",
    severity: "important",
    title: `سفارش ${toPersianDigits(input.orderNumber)} به آشپزخانه رسید`,
    body: itemSummary(input.items),
    url: "/accounting/kitchen",
    dedupeKey: notificationDedupeKey("kitchen.ticket_created", input.orderId),
    payload: {
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      itemIds: [...input.itemIds],
    },
  });
}

/**
 * A new round was added to an order the kitchen already knows. The key covers
 * the exact line-id set, so the same round is one notification however many
 * times the request, sync replay or realtime fan-out delivers it.
 */
export async function recordKitchenItemsAdded(input: {
  businessId: string;
  locationId: string;
  orderId: string;
  orderNumber: number;
  items: readonly { name: string; quantity: number }[];
  itemIds: readonly string[];
}): Promise<boolean> {
  if (input.itemIds.length === 0) return false;
  return recordNotification({
    businessId: input.businessId,
    locationId: input.locationId,
    eventKey: "kitchen.items_added",
    severity: "important",
    title: `اقلام تازه به سفارش ${toPersianDigits(input.orderNumber)} اضافه شد`,
    body: itemSummary(input.items),
    url: "/accounting/kitchen",
    dedupeKey: notificationDedupeKey(
      "kitchen.items_added",
      input.orderId,
      itemSetDigest(input.itemIds),
    ),
    payload: {
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      itemIds: [...input.itemIds],
    },
  });
}

interface AgingTicketRow extends Record<string, unknown> {
  location_id: string;
  order_id: string;
  order_number: string | number;
  sent_at: string | Date;
  item_ids: string[];
}

/**
 * Queue the `kitchen.ticket_aged` events for one business. The age is always
 * `now - MIN(sent_to_kitchen_at)` from the persisted line timestamp, never a
 * client clock. The dedupe key includes the stage and the exact set of late
 * lines, so:
 *   - repeated scans of an unchanged ticket queue nothing;
 *   - approaching then overdue is two facts and two notifications;
 *   - a later round that pushes the same order late again is a new line set
 *     and is allowed to notify again.
 */
export async function scanKitchenTicketAging(businessId: string): Promise<number> {
  const { byLocation, fallback } = await kitchenAlertThresholdsByLocation(businessId);
  const { rows } = await query<AgingTicketRow>(
    // The ticket's age is the earliest sent line across all visible statuses,
    // exactly as the KDS groups it. `item_ids` names only the lines still in
    // preparation, so a ready handoff does not keep re-keying the alert; the
    // HAVING clause skips a ticket with no active preparation left.
    `SELECT oi.location_id,
            oi.order_id,
            o.order_number::text AS order_number,
            MIN(oi.sent_to_kitchen_at) AS sent_at,
            array_agg(oi.id ORDER BY oi.id)
              FILTER (WHERE oi.status IN ('sent', 'preparing')) AS item_ids
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.location_id IN (SELECT id FROM locations WHERE business_id = $1 AND is_active)
        AND o.status IN ('open', 'held', 'completed')
        AND (o.website_approval_state IS NULL OR o.website_approval_state = 'accepted')
        AND oi.status IN ('sent', 'preparing', 'ready')
        AND oi.kitchen_archived_at IS NULL
        AND (oi.kitchen_clear_at IS NULL OR oi.kitchen_clear_at > now())
        AND oi.sent_to_kitchen_at IS NOT NULL
        AND oi.sent_to_kitchen_at <= now() - interval '1 minute'
      GROUP BY oi.location_id, oi.order_id, o.order_number
      HAVING bool_or(oi.status IN ('sent', 'preparing'))
      ORDER BY MIN(oi.sent_to_kitchen_at) ASC
      LIMIT ${MAX_KITCHEN_AGING_ROWS}`,
    [businessId],
  );

  const now = Date.now();
  let queued = 0;
  for (const row of rows) {
    if (queued >= MAX_KITCHEN_AGING_ALERTS_PER_SCAN) break;
    const sentAtMs =
      typeof row.sent_at === "string" ? Date.parse(row.sent_at) : new Date(row.sent_at).getTime();
    if (!Number.isFinite(sentAtMs)) continue;
    const thresholds = byLocation.get(row.location_id) ?? fallback;
    const stage = kitchenAgingStage(ticketAgeMinutes(sentAtMs, now), thresholds);
    if (stage === "within") continue;

    const orderNumber = Number(row.order_number);
    const ageMinutes = Math.floor(ticketAgeMinutes(sentAtMs, now));
    await recordNotification({
      businessId,
      locationId: row.location_id,
      eventKey: "kitchen.ticket_aged",
      severity: stage === "overdue" ? "important" : "info",
      title:
        stage === "overdue"
          ? `سفارش ${toPersianDigits(orderNumber)} از آستانهٔ آماده‌سازی گذشت`
          : `سفارش ${toPersianDigits(orderNumber)} به آستانهٔ آماده‌سازی نزدیک شد`,
      body: `${toPersianDigits(ageMinutes)} دقیقه از ارسال به آشپزخانه — آستانهٔ تأخیر ${toPersianDigits(
        thresholds.overdueMinutes,
      )} دقیقه${
        thresholds.approachingMinutes === null
          ? ""
          : ` — آستانهٔ نزدیک‌شدن ${toPersianDigits(thresholds.approachingMinutes)} دقیقه`
      }`,
      url: "/accounting/kitchen",
      dedupeKey: notificationDedupeKey(
        "kitchen.ticket_aged",
        row.order_id,
        stage,
        itemSetDigest(row.item_ids),
      ),
      payload: {
        orderId: row.order_id,
        orderNumber,
        stage,
        ageMinutes,
        overdueMinutes: thresholds.overdueMinutes,
        approachingMinutes: thresholds.approachingMinutes,
      },
    });
    queued += 1;
  }
  return queued;
}
