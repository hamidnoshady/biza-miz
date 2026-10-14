/**
 * Phase 21 Wave 5 — watch (ساعت): serialized units, warranty windows, and
 * the repair-ticket state machine (pure helpers).
 *
 * The pure counterpart of `watch-sales-service.ts`/`repairs-service.ts`,
 * mirroring `gold.ts`'s role for Waves 2-4: everything here validates an
 * input against exactly what the database's own CHECK constraints enforce
 * (migrations/0067), so a bad request is rejected before it reaches
 * Postgres, and computes the one piece of real date arithmetic this wave
 * needs (a warranty's end date).
 */

/** Mirrors item_serials.unit_cost's CHECK — Rial, whole, positive when set at all. */
export function validateSerialUnitCost(unitCost: number | null | undefined): string | null {
  if (unitCost == null) return null;
  if (!Number.isInteger(unitCost) || unitCost <= 0) {
    return "بهای تمام‌شده باید یک عدد صحیح مثبت (ریال) باشد.";
  }
  return null;
}

/** Mirrors item_serials.warranty_months' CHECK. Zero is a real answer ("sold with no warranty"), not a missing one. */
export function validateWarrantyMonths(months: number): string | null {
  if (!Number.isInteger(months) || months < 0) {
    return "مدت گارانتی باید یک عدد صحیح غیرمنفی (ماه) باشد.";
  }
  if (months > 600) return "مدت گارانتی بیش از حد بزرگ است.";
  return null;
}

/**
 * The Gregorian date `months` months after `isoDate` (YYYY-MM-DD), clamped
 * to the last day of the target month so a 31st never rolls into the next
 * month (31 فروردین + 1 ماه is the end of that month, not the 1st of the
 * one after — a warranty that silently gained a day would be a real,
 * customer-visible bug). Dates are stored ISO/Gregorian per the repo's
 * storage conventions; Jalali is a display concern (src/lib/jalali.ts).
 */
export function addMonthsToIsoDate(isoDate: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error("تاریخ نامعتبر است.");
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);

  const totalMonths = (year * 12 + (month - 1)) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;

  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);

  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

/** Whether a warranty window (inclusive of both ends) covers `onDate` — the check a repair intake makes against the linked unit. */
export function isWarrantyActive(
  warranty: { startDate: string; endDate: string } | null,
  onDate: string,
): boolean {
  if (!warranty) return false;
  return warranty.startDate <= onDate && onDate <= warranty.endDate;
}

export type RepairStatus = "received" | "in_progress" | "ready" | "closed" | "cancelled";
export const REPAIR_STATUSES: RepairStatus[] = [
  "received",
  "in_progress",
  "ready",
  "closed",
  "cancelled",
];

export const REPAIR_STATUS_LABELS: Record<RepairStatus, string> = {
  received: "پذیرش شده",
  in_progress: "در حال تعمیر",
  ready: "آماده تحویل",
  closed: "تحویل شده",
  cancelled: "لغو شده",
};

/**
 * The workflow the phase doc calls for: پذیرش → مصرف قطعات → اجرت → بستن.
 * Deliberately its own small state machine rather than a reuse of Phase 4's
 * kitchen-ticket states (open question 5, now settled): a kitchen ticket
 * lives for minutes and never gets billed, a repair ticket lives for days,
 * accrues parts and labor, and posts to the ledger when it closes — the two
 * share a shape but nothing else.
 *
 * `closed` and `cancelled` are both terminal; `closed` is additionally
 * never reachable through this function, because closing a ticket posts its
 * journal entries and so has to go through `closeRepairTicket`
 * (repairs-service.ts) rather than a bare status update.
 */
export function validateRepairStatusTransition(from: RepairStatus, to: RepairStatus): string | null {
  if (from === to) return null;
  if (from === "closed" || from === "cancelled") {
    return "تیکت بسته‌شده یا لغوشده را نمی‌توان تغییر داد.";
  }
  if (to === "closed") {
    return "برای بستن تیکت از عملیات «تسویه و بستن» استفاده کنید.";
  }
  if (to === "cancelled") return null;
  const order: RepairStatus[] = ["received", "in_progress", "ready"];
  const fromIdx = order.indexOf(from);
  const toIdx = order.indexOf(to);
  if (toIdx < 0) return "وضعیت نامعتبر است.";
  if (toIdx < fromIdx) return "بازگرداندن تیکت به وضعیت قبلی مجاز نیست.";
  return null;
}

/**
 * Issue #795 Phase 1 — where a consumed repair part came from. `stock` is a
 * part the shop pulled from its own inventory (relieved from the industry's
 * inventory account when the ticket closes); `external` is a part bought
 * outside for this one job or supplied by the customer, whose cost is
 * recorded by the purchase/expense that acquired it — closing the ticket
 * must not credit the shop's inventory for something that was never in it.
 */
export type RepairPartSource = "stock" | "external";
export const REPAIR_PART_SOURCES: RepairPartSource[] = ["stock", "external"];

/** Mirrors repair_ticket_parts.source's CHECK (migration 0199). */
export function validateRepairPartSource(source: string): string | null {
  if (!(REPAIR_PART_SOURCES as string[]).includes(source)) {
    return "منبع قطعه نامعتبر است (از انبار یا خرید بیرونی).";
  }
  return null;
}

/**
 * Issue #795 Phase 1 — the warranty billing invariant, enforced in the
 * service layer (not the UI): an under-warranty ticket bills the customer
 * nothing, unless the shop has recorded an explicit out-of-coverage reason
 * (`repair_tickets.non_covered_reason`) agreed with the customer. A
 * warranty flag must never silently coexist with an ordinary customer bill.
 */
export function validateWarrantyCharge(
  underWarranty: boolean,
  charge: number,
  nonCoveredReason: string | null | undefined,
): string | null {
  if (!underWarranty) return null;
  if (charge <= 0) return null;
  if (nonCoveredReason?.trim()) return null;
  return "این تیکت در گارانتی است؛ دریافت مبلغ از مشتری فقط با ثبت «علت خارج از پوشش گارانتی» مجاز است.";
}

export interface RepairPartInput {
  description: string;
  quantity: string;
  /** What the part cost the shop (Rial, whole) — relieved from inventory when the ticket closes. */
  unitCost: number;
  /** What the customer is billed for it (Rial, whole) — zero on a warranty repair. */
  charge: number;
  /** Where the part came from; omitted means `stock` (the pre-0199 behavior). */
  source?: RepairPartSource;
}

export type ConditionGrade = "new" | "like_new" | "good" | "fair" | "poor";
export const CONDITION_GRADES: ConditionGrade[] = ["new", "like_new", "good", "fair", "poor"];

/** Mirrors item_serials.condition_grade's CHECK — free only for a pre-owned intake. */
export function validateConditionGrade(grade: string | null | undefined): string | null {
  if (grade == null) return null;
  if (!(CONDITION_GRADES as string[]).includes(grade)) return "درجه وضعیت کالای دست‌دوم نامعتبر است.";
  return null;
}

/** Mirrors items.service_interval_months' CHECK — NULL means no service reminder for this model. */
export function validateServiceIntervalMonths(months: number | null | undefined): string | null {
  if (months == null) return null;
  if (!Number.isInteger(months) || months <= 0 || months > 120) {
    return "فاصلهٔ سرویس باید عددی صحیح بین ۱ تا ۱۲۰ ماه باشد.";
  }
  return null;
}

/**
 * When a sold unit next comes due for service: its sale date plus the
 * model's service interval. No interval means no reminder (null).
 */
export function serviceDueDate(soldAtIso: string | null, intervalMonths: number | null): string | null {
  if (!soldAtIso || !intervalMonths) return null;
  return addMonthsToIsoDate(soldAtIso, intervalMonths);
}

export type ServiceReminderState = "overdue" | "due" | "ok";

/**
 * A service/battery reminder derived from a reference date (the warranty end,
 * or the sale date). Due within `leadDays`, overdue once past, ok otherwise.
 */
export function serviceReminderState(referenceDate: string, todayIso: string, leadDays: number): ServiceReminderState {
  const ref = Date.parse(`${referenceDate}T00:00:00Z`);
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(ref) || Number.isNaN(today)) return "ok";
  const daysLeft = Math.floor((ref - today) / 86_400_000);
  if (daysLeft < 0) return "overdue";
  if (daysLeft <= leadDays) return "due";
  return "ok";
}

/** Mirrors repair_ticket_parts' own CHECK constraints. */
export function validateRepairPart(input: RepairPartInput): string[] {
  const errors: string[] = [];
  if (!input.description?.trim()) errors.push("شرح قطعه نمی‌تواند خالی باشد.");

  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    errors.push("تعداد قطعه باید بزرگ‌تر از صفر باشد.");
  }
  if (!Number.isInteger(input.unitCost) || input.unitCost < 0) {
    errors.push("بهای تمام‌شده قطعه باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }
  if (!Number.isInteger(input.charge) || input.charge < 0) {
    errors.push("مبلغ دریافتی بابت قطعه باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }
  if (input.source != null) {
    const sourceError = validateRepairPartSource(input.source);
    if (sourceError) errors.push(sourceError);
  }
  return errors;
}
