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
import { formatRialText } from "./money";
import { ACCOUNTING_WORKSPACE_HREFS, workspaceProjectHref } from "./app-routes";
import { businessToday } from "./business-day-service";
import { AecError, AEC_INDUSTRY } from "./aec-service";
import {
  certifiedClaimsAwaitingPayment,
  expiringSecurities,
  pendingCertificates,
} from "./aec-commercial-service";
import { overdueRegisters } from "./aec-rfi-service";
import { overdueSiteIssues } from "./aec-site-service";
import { getBusinessIndustry } from "./industry-guard";
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
 * §29's AEC reminders scan on the same slow cadence as the reorder level: an
 * overdue RFI is a "chase this today" fact, and re-reading every business's
 * registers every ten minutes to learn the same thing would be waste. One hour
 * is enough for a reminder whose dedupe key is a business *date* — the second
 * scan of a day queues nothing at all.
 */
export const AEC_OVERDUE_SCAN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * At most this many entries of *each* register per business per day, so one
 * project's backlog cannot flood a phone and cannot silence another register
 * either: with four registers feeding this scan, one shared budget would let a
 * stack of late RFIs hide the snags somebody has to fix this week.
 */
const MAX_OVERDUE_PER_SCAN = 10;

/**
 * One business's overdue registers, queued as notifications.
 *
 * The four halves come from `overdueRegisters` (§10/§11) and `overdueSiteIssues`
 * (§14), which are the same functions the assistant's pending reads and the
 * cockpit widgets use — so a reminder and a screen can never disagree about
 * which register is late. The RFI half is why nothing here checks the industry:
 * it answers no rows for a business that is not AEC, and the submittal and site
 * halves skip themselves when document control or quality control is off, so a
 * trade of any kind can be swept safely.
 *
 * The dedupe key is `…:<record id>:<business date>`, exactly like low stock: one
 * reminder per register entry per trading day, however many times the scan runs.
 * A record that stays overdue for a fortnight is a fortnight of daily nudges
 * rather than one lost alert or fifty duplicate ones.
 *
 * §29 names «inspection due» and «snag overdue» separately from the two
 * registers, and they are separate keys here because they are separate things to
 * switch off — the split between them is the issue's own: inspection-ish kinds
 * (the request, the inspection, the handover) raise one, and defect-ish kinds
 * (the snag, the NCR, the corrective action) the other.
 */
export async function scanOverdueAecRegisters(businessId: string): Promise<number> {
  return scanAecRegisters(businessId);
}

/**
 * §29's commercial reminders, from the same scan.
 *
 * Four facts that become true by a date passing rather than by a write:
 *
 *   * a claim submitted and not certified for a fortnight
 *     (`aec.payment_certificate_pending`);
 *   * a certified claim a month old whose receipt nobody has confirmed
 *     (`aec.client_payment_overdue`) — a *follow-up*, worded as one, because the
 *     workspace does not know whether the money arrived and inventing a
 *     "received" column to compare against is exactly the duplicated balance
 *     §16 forbids;
 *   * a guarantee/bond and an insurance policy approaching their expiry
 *     (`aec.guarantee_expiring`, `aec.insurance_expiring`), which is §22's
 *     «Guarantee/Bond Expiry» widget as a reminder.
 *
 * Each half skips itself when its capability is off, so a trade of any kind can
 * be swept safely: the certificate reads raise `capability_disabled`, which is a
 * switch rather than a failure.
 */
async function scanCommercialControls(
  businessId: string,
  today: string,
  queue: (entry: Parameters<typeof recordNotification>[0]) => Promise<void>,
  budget: { value: number },
  securityBudget: { guarantee: { value: number }; insurance: { value: number } },
): Promise<void> {
  const certificates = await swallowCapability(() =>
    pendingCertificates(businessId, { limit: MAX_OVERDUE_PER_SCAN }),
  );
  for (const certificate of certificates) {
    if (budget.value >= MAX_OVERDUE_PER_SCAN) break;
    if (certificate.daysWaiting < CERTIFICATE_PENDING_DAYS) continue;
    await queue({
      businessId,
      // No location: a claim belongs to a project, not to a branch.
      locationId: null,
      eventKey: "aec.payment_certificate_pending",
      severity: "important",
      title: `${certificate.kindLabel} ${certificate.certificateNumber} در انتظار تأیید است`,
      body: `${certificate.daysWaiting} روز از ارسال آن گذشته است — مبلغ خالص ${formatRialText(String(certificate.netRial))}${certificate.contractTitle ? ` — قرارداد: ${certificate.contractTitle}` : ""}`,
      url: workspaceProjectHref(certificate.projectId),
      dedupeKey: notificationDedupeKey("aec.payment_certificate_pending", certificate.id, today),
      payload: { certificateId: certificate.id, projectId: certificate.projectId },
    });
    budget.value += 1;
  }

  const awaitingPayment = await swallowCapability(() =>
    certifiedClaimsAwaitingPayment(businessId, { limit: MAX_OVERDUE_PER_SCAN }),
  );
  for (const claim of awaitingPayment) {
    if (budget.value >= MAX_OVERDUE_PER_SCAN) break;
    await queue({
      businessId,
      locationId: null,
      eventKey: "aec.client_payment_overdue",
      severity: "important",
      title: `وصول صورت‌وضعیت ${claim.certificateNumber} را بررسی کنید`,
      body: `${claim.daysSinceCertified} روز از تأیید آن گذشته است — مبلغ تأییدشده ${formatRialText(String(claim.certifiedRial))}؛ دریافت را در حسابداری بررسی کنید.`,
      url: workspaceProjectHref(claim.projectId),
      dedupeKey: notificationDedupeKey("aec.client_payment_overdue", claim.id, today),
      payload: { certificateId: claim.id, projectId: claim.projectId },
    });
    budget.value += 1;
  }

  const securities = await swallowCapability(() =>
    expiringSecurities(businessId, { withinDays: GUARANTEE_WINDOW_DAYS, limit: MAX_OVERDUE_PER_SCAN * 2 }),
  );
  for (const security of securities) {
    const key = security.kind === "insurance" ? "aec.insurance_expiring" : "aec.guarantee_expiring";
    // One budget per event key: a business with many bonds must not silence the
    // one insurance policy that is about to lapse.
    const used = security.kind === "insurance" ? securityBudget.insurance : securityBudget.guarantee;
    if (used.value >= MAX_OVERDUE_PER_SCAN) continue;
    await queue({
      businessId,
      locationId: null,
      eventKey: key,
      severity: "important",
      title:
        security.kind === "insurance"
          ? `بیمه‌نامهٔ قرارداد «${security.contractTitle}» تا ${security.daysRemaining} روز دیگر منقضی می‌شود`
          : `ضمانت‌نامهٔ قرارداد «${security.contractTitle}» تا ${security.daysRemaining} روز دیگر منقضی می‌شود`,
      body: `${security.reference} — تاریخ انقضا ${formatJalali(security.guaranteeExpiry)}${
        security.guaranteeAmountRial
          ? ` — مبلغ ${formatRialText(String(security.guaranteeAmountRial))}`
          : ""
      }`,
      // A business-level contract has no project to open; the contracts screen is
      // where its bond is edited either way.
      url: security.projectId ? workspaceProjectHref(security.projectId) : "/workspace/contracts",
      dedupeKey: notificationDedupeKey(key, security.contractId + security.kind, today),
      payload: { contractId: security.contractId, projectId: security.projectId },
    });
    used.value += 1;
  }
}

async function scanAecRegisters(businessId: string): Promise<number> {
  // The sweep runs for every business; this register is one business's. Asking
  // the RFI register for a restaurant would *throw* (its guard asserts the
  // industry), and an hourly exception per non-AEC business is not a sweep. One
  // industry read, then nothing — the reason low stock needs no such check is
  // that every business can have stock.
  if ((await getBusinessIndustry(businessId)) !== AEC_INDUSTRY) return 0;

  const today = await businessToday(businessId);
  const { rfis, submittals } = await overdueRegisters(businessId);
  const siteIssues = await overdueSiteIssues(businessId, MAX_OVERDUE_PER_SCAN);

  let queued = 0;
  // One budget per register, not one for the scan: a project with fifty late
  // RFIs must not silence the snags somebody has to fix this week.
  let fromThisRegister = 0;
  for (const rfi of rfis) {
    if (fromThisRegister >= MAX_OVERDUE_PER_SCAN) break;
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
    fromThisRegister += 1;
  }

  fromThisRegister = 0;
  for (const submittal of submittals) {
    if (fromThisRegister >= MAX_OVERDUE_PER_SCAN) break;
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
    fromThisRegister += 1;
  }

  fromThisRegister = 0;
  for (const issue of siteIssues) {
    if (fromThisRegister >= MAX_OVERDUE_PER_SCAN) break;
    if (issue.daysOverdue <= 0) continue;
    const inspection = SITE_INSPECTION_KINDS.has(issue.kind);
    const eventKey = inspection ? "aec.inspection_due" : "aec.snag_overdue";
    await recordNotification({
      businessId,
      // No location: the site belongs to a project, not to a branch.
      locationId: null,
      eventKey,
      severity: "important",
      title: inspection
        ? `${issue.kindLabel} ${issue.issueNumber} از مهلت گذشته است`
        : `${issue.kindLabel} ${issue.issueNumber} عقب افتاده است`,
      body: `${issue.title} — ${issue.daysOverdue} روز گذشته، مهلت ${formatJalali(
        issue.dueDate ?? "",
      )}${issue.assigneeName ? ` — مسئول: ${issue.assigneeName}` : ""}`,
      url: workspaceProjectHref(issue.projectId),
      dedupeKey: notificationDedupeKey(eventKey, issue.id, today),
      payload: { siteIssueId: issue.id, projectId: issue.projectId, dueDate: issue.dueDate },
    });
    queued += 1;
    fromThisRegister += 1;
  }

  // Wave 8's commercial four, through the same per-register budgets: a company
  // with fifty late claims must not silence the bond that expires next week.
  const securityBudget = { guarantee: { value: 0 }, insurance: { value: 0 } };
  await scanCommercialControls(
    businessId,
    today,
    async (entry) => {
      await recordNotification(entry);
      queued += 1;
    },
    { value: 0 },
    securityBudget,
  );

  return queued;
}

/**
 * Which §14 kinds are «inspections» for §29's reminder split. The request, the
 * inspection itself and the handover: things that happen on a date. Everything
 * else in the register is a defect somebody owes a fix for.
 */
const SITE_INSPECTION_KINDS = new Set(["inspection_request", "inspection", "handover"]);

/** How long a claim may wait for certification before somebody is nudged. */
const CERTIFICATE_PENDING_DAYS = 14;

/** The horizon §29's guarantee and insurance reminders look ahead over. */
const GUARANTEE_WINDOW_DAYS = 60;

/**
 * Runs a commercial read that may be switched off.
 *
 * The certificate, guarantee and insurance queues all raise
 * `capability_disabled` for a business that has the industry but not the
 * capability — a switch, not a failure — and the hourly sweep must not throw on
 * it. Anything else is a real error and goes up.
 */
async function swallowCapability<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AecError && error.code === "capability_disabled") return [];
    throw error;
  }
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
