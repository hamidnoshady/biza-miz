/**
 * Phase 35 — the one *scanned* notification producer.
 *
 * Every other producer is an event: something happened in one place in the code
 * (a shift closed, a backup failed, a coworker run needs approving) and that
 * place enqueues. `inventory.low_stock` cannot work that way. Stock leaves an
 * item through at least six paths — a sale's recipe deduction, a waste
 * write-off, a transfer out, a production consume, a stock count, a supplier
 * return — and a threshold crossing is a property of the *level* after any of
 * them, not of any one of them. Putting the check in all six would guarantee
 * that the seventh, added later, silently does not notify.
 *
 * So this scans instead, on its own slow cadence, and leans on the same
 * idempotency every other producer uses: the dedupe key is
 * `inventory.low_stock:<item>:<business date>`, so an item that sits below its
 * reorder level all week produces one notification per trading day rather than
 * one every ten minutes. `app_business_date` is what makes "day" mean the
 * branch's trading day (migration 0076), so a café working 18:00→03:00 gets one
 * alert for one night rather than two at midnight.
 *
 * It only enqueues — the tick in notifications-service.ts is still the only
 * thing that sends.
 *
 * Wave 6 (issue #799 §29) adds a second scanned producer for the same reason,
 * which is why it lives in this file rather than in the AEC module: an RFI or a
 * submittal becomes overdue by the passage of a *date*, not by any write, so
 * there is nowhere to hang an event. §29 also says explicitly to ride the
 * existing engine rather than build a second one, so the scan does what the
 * low-stock scan does — read, dedupe per business day, `recordNotification` —
 * and delivery stays entirely in the service above.
 */
import { query, withoutTenantScope, withTenant } from "./db";
import { isFeatureEnabled } from "./features";
import { recordNotification } from "./notification-events";
import { notificationDedupeKey } from "./notifications";
import { formatQuantity } from "./digits";
import { ACCOUNTING_WORKSPACE_HREFS, workspaceProjectHref } from "./app-routes";
import { businessToday } from "./business-day-service";
import { overdueRegisters } from "./aec-rfi-service";
import { formatJalali } from "./jalali";

/**
 * Slow on purpose. A reorder level is a "order more this week" signal, not a
 * live one, and re-scanning every business's inventory every fifteen seconds to
 * discover a fact that changes twice a day would cost far more than it is worth.
 */
export const LOW_STOCK_SCAN_INTERVAL_MS = 10 * 60 * 1000;

/** At most this many items per branch per scan, so one badly-configured store room can't flood a phone. */
const MAX_ITEMS_PER_SCAN = 10;

interface LowStockRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  name: string;
  unit: string;
  on_hand: string;
  reorder_level: string;
  business_date: string;
}

/**
 * One business's items at or below their reorder level, with the branch's own
 * trading date attached so the dedupe key can be built from it.
 *
 * Mirrors the `low_stock` fact `ai-coworker-service.ts` already loads — same
 * `stock_movements` sum, same `reorder_level IS NOT NULL AND > 0` guard — so
 * the notification and the coworker's purchase draft cannot disagree about
 * which items are short.
 */
export async function scanLowStock(businessId: string): Promise<number> {
  if (!(await isFeatureEnabled(businessId, "inventory"))) return 0;

  const { rows } = await query<LowStockRow>(
    `SELECT i.id, i.location_id, i.name, i.unit,
            trim_scale(COALESCE(sm.total, 0))::text AS on_hand,
            trim_scale(i.reorder_level)::text       AS reorder_level,
            app_business_date(now(), l.timezone, l.business_day_start_minutes)::text AS business_date
       FROM inventory_items i
       JOIN locations l ON l.id = i.location_id
       LEFT JOIN (
         SELECT inventory_item_id, sum(quantity) AS total
           FROM stock_movements GROUP BY inventory_item_id
       ) sm ON sm.inventory_item_id = i.id
      WHERE l.business_id = $1 AND l.is_active AND i.is_active
        AND i.reorder_level IS NOT NULL AND i.reorder_level > 0
        AND COALESCE(sm.total, 0) <= i.reorder_level
      ORDER BY i.location_id, i.name`,
    [businessId],
  );

  const perLocation = new Map<string, number>();
  let queued = 0;
  for (const row of rows) {
    const seen = perLocation.get(row.location_id) ?? 0;
    if (seen >= MAX_ITEMS_PER_SCAN) continue;
    perLocation.set(row.location_id, seen + 1);

    await recordNotification({
      businessId,
      locationId: row.location_id,
      eventKey: "inventory.low_stock",
      severity: "important",
      title: `${row.name} به نقطهٔ سفارش رسید`,
      body: `موجودی ${formatQuantity(row.on_hand)} ${row.unit} — نقطهٔ سفارش ${formatQuantity(row.reorder_level)} ${row.unit}`,
      url: ACCOUNTING_WORKSPACE_HREFS.inventory,
      dedupeKey: notificationDedupeKey("inventory.low_stock", row.id, row.business_date),
      payload: { inventoryItemId: row.id, onHand: row.on_hand, reorderLevel: row.reorder_level },
    });
    queued += 1;
  }
  return queued;
}

/**
 * §29's two reminders scan on the same slow cadence as the reorder level: an
 * overdue RFI is a "chase this today" fact, and re-reading every business's
 * registers every ten minutes to learn the same thing would be waste. One hour
 * is enough for a reminder whose dedupe key is a business *date* — the second
 * scan of a day queues nothing at all.
 */
export const AEC_OVERDUE_SCAN_INTERVAL_MS = 60 * 60 * 1000;

/** At most this many of each register per business per day, so one project's backlog cannot flood a phone. */
const MAX_OVERDUE_PER_SCAN = 10;

/**
 * One business's overdue RFIs and submittals, queued as notifications.
 *
 * Both halves come from `overdueRegisters`, which is the same function the
 * assistant's two pending reads and the two cockpit widgets use — so a
 * reminder and a screen can never disagree about which register is late. The
 * function itself is why nothing here checks the industry: it answers no rows
 * for a business that is not AEC, and its submittal half is skipped when
 * document control is off, so a trade of any kind can be swept safely.
 *
 * The dedupe key is `…:<record id>:<business date>`, exactly like low stock: one
 * reminder per register entry per trading day, however many times the scan runs.
 * A record that stays overdue for a fortnight is a fortnight of daily nudges
 * rather than one lost alert or fifty duplicate ones.
 */
export async function scanOverdueAecRegisters(businessId: string): Promise<number> {
  const today = await businessToday(businessId);
  const { rfis, submittals } = await overdueRegisters(businessId);

  let queued = 0;
  for (const rfi of rfis) {
    if (queued >= MAX_OVERDUE_PER_SCAN) break;
    if (rfi.daysOverdue <= 0) continue;
    await recordNotification({
      businessId,
      // No location: the registers belong to projects, not to branches.
      locationId: null,
      eventKey: "aec.rfi_overdue",
      severity: "important",
      title: `استعلام ${rfi.rfiNumber} از مهلت گذشته است`,
      body: `${rfi.subject} — ${rfi.daysOverdue} روز گذشته، مهلت ${formatJalali(rfi.dueDate ?? "")}${
        rfi.responsiblePartyName ? ` — مسئول: ${rfi.responsiblePartyName}` : ""
      }`,
      url: workspaceProjectHref(rfi.projectId),
      dedupeKey: notificationDedupeKey("aec.rfi_overdue", rfi.id, today),
      payload: { rfiId: rfi.id, projectId: rfi.projectId, dueDate: rfi.dueDate },
    });
    queued += 1;
  }

  for (const submittal of submittals) {
    if (queued >= MAX_OVERDUE_PER_SCAN) break;
    if (submittal.daysOverdue <= 0) continue;
    await recordNotification({
      businessId,
      locationId: null,
      eventKey: "aec.submittal_overdue",
      severity: "important",
      title: `سابمیتال ${submittal.submittalNumber} از مهلت گذشته است`,
      body: `${submittal.title} — ${submittal.daysOverdue} روز گذشته، مهلت ${formatJalali(
        submittal.dueDate ?? "",
      )}${submittal.reviewerName ? ` — بازبین: ${submittal.reviewerName}` : ""}`,
      url: workspaceProjectHref(submittal.projectId),
      dedupeKey: notificationDedupeKey("aec.submittal_overdue", submittal.id, today),
      payload: {
        submittalId: submittal.id,
        projectId: submittal.projectId,
        dueDate: submittal.dueDate,
      },
    });
    queued += 1;
  }

  return queued;
}

let scanInFlight = false;

/**
 * The background scan (server.ts).
 *
 * Enumerates businesses under the documented platform bypass and wraps each
 * one's scan in `withTenant`, the same shape as every other tick. A business
 * whose scan fails is logged and skipped rather than aborting the rest — one
 * tenant's misconfigured inventory must not stop another's alerts.
 */
export async function runLowStockScanTick(): Promise<number> {
  if (scanInFlight) return 0;
  scanInFlight = true;
  try {
    const businessIds = await withoutTenantScope("platform", async () => {
      const { rows } = await query<{ id: string }>(
        "SELECT id FROM businesses WHERE status = 'active' ORDER BY id",
      );
      return rows.map((row) => row.id);
    });

    let queued = 0;
    for (const businessId of businessIds) {
      try {
        queued += await withTenant(businessId, () => scanLowStock(businessId));
      } catch (error) {
        console.error(
          `low-stock scan failed for business ${businessId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return queued;
  } finally {
    scanInFlight = false;
  }
}

let aecScanInFlight = false;

/**
 * The AEC overdue sweep (server.ts), with its own in-flight latch: a business
 * whose register read fails (an install without the AEC tables, a capability
 * refused mid-flight) is logged and skipped, never allowed to abort the sweep
 * for everyone else.
 */
export async function runAecOverdueScanTick(): Promise<number> {
  if (aecScanInFlight) return 0;
  aecScanInFlight = true;
  try {
    const businessIds = await withoutTenantScope("platform", async () => {
      const { rows } = await query<{ id: string }>(
        "SELECT id FROM businesses WHERE status = 'active' ORDER BY id",
      );
      return rows.map((row) => row.id);
    });

    let queued = 0;
    for (const businessId of businessIds) {
      try {
        queued += await withTenant(businessId, () => scanOverdueAecRegisters(businessId));
      } catch (error) {
        console.error(
          `AEC overdue scan failed for business ${businessId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return queued;
  } finally {
    aecScanInFlight = false;
  }
}
