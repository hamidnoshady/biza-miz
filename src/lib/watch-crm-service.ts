/**
 * Phase 27 Wave 10 — the watch flagship (DB-touching): service/battery
 * reminders, pre-owned intake provenance, and the repair estimate → approval
 * step.
 *
 * Reminders derive from the model's service interval: a sold unit comes due
 * `service_interval_months` after its sale date (a quartz battery ~2 years,
 * an automatic movement 3–5), so no new calendar table is needed. Pre-owned
 * intake records a condition grade and the box-and-papers checklist on the
 * serial. A repair estimate is recorded on the ticket, approved by the
 * customer, and moving to `in_progress`/closing without approval is refused
 * (repairs-service.ts).
 */
import { query } from "./db";
import {
  serviceDueDate,
  serviceReminderState,
  validateConditionGrade,
  type ConditionGrade,
  type ServiceReminderState,
} from "./watch";
import { renderRepairEstimate } from "./repair-estimate";
import { computeRepairCharge } from "./watch-pricing";
import type { MoneyUnit } from "./money";

interface ServiceReminderRow {
  serialId: string;
  serialNumber: string;
  itemName: string;
  customerName: string | null;
  customerPhone: string | null;
  /** The ISO date of the last qualifying completed service, if any. */
  lastServiceDate: string | null;
  /** The ISO date the unit comes due for service (anchor date + interval). */
  referenceDate: string;
  state: ServiceReminderState;
}

/**
 * Sold units whose next service is within `leadDays` or past — the
 * due-for-service list the shop's home page surfaces.
 *
 * Issue #795 items 13 & 14:
 * - The anchor rolls forward: `last qualifying completed service ?? sale
 *   date` plus the model's interval. A *qualifying* service is any CLOSED
 *   repair ticket linked to the serial (a cancelled intake never serviced
 *   anything), so an overdue watch stops being overdue the day its service
 *   ticket closes — the close date becomes the next anchor.
 * - The reminder knows WHO to call: the buyer on the latest completed
 *   invoice line that sold this serial (ownership from the persisted sale,
 *   a resold unit belongs to its newest owner), with the ticket's own
 *   customer as fallback for units serviced but never sold here.
 *
 * A model without an interval never appears.
 */
export async function serviceReminders(
  locationId: string,
  todayIso: string,
  leadDays: number,
): Promise<ServiceReminderRow[]> {
  const { rows } = await query<{
    serial_id: string;
    serial_number: string;
    item_name: string;
    sold_at: string | null;
    last_service: string | null;
    service_interval_months: number | null;
    customer_name: string | null;
    customer_phone: string | null;
  }>(
    `SELECT s.id AS serial_id, s.serial_number, i.name AS item_name,
            s.sold_at::text AS sold_at, i.service_interval_months,
            svc.last_service::text AS last_service,
            p.name AS customer_name, p.phone AS customer_phone
       FROM item_serials s
       JOIN items i ON i.id = s.item_id
       LEFT JOIN LATERAL (
         SELECT max(rt.closed_at)::date AS last_service
           FROM repair_tickets rt
          WHERE rt.serial_id = s.id AND rt.status = 'closed'
       ) svc ON true
       LEFT JOIN LATERAL (
         SELECT o.customer_id
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE o.location_id = $1 AND o.status = 'completed' AND oi.status <> 'voided'
            AND oi.retail_snapshot ->> 'kind' = 'watch'
            AND oi.retail_snapshot ->> 'serialId' = s.id::text
          ORDER BY o.closed_at DESC NULLS LAST
          LIMIT 1
       ) own ON true
       LEFT JOIN LATERAL (
         SELECT rt.customer_id
           FROM repair_tickets rt
          WHERE rt.serial_id = s.id AND rt.customer_id IS NOT NULL
          ORDER BY rt.created_at DESC
          LIMIT 1
       ) tkt ON true
       LEFT JOIN parties p ON p.id = coalesce(own.customer_id, tkt.customer_id)
      WHERE i.location_id = $1 AND s.status = 'sold' AND s.sold_at IS NOT NULL`,
    [locationId],
  );

  const reminders: ServiceReminderRow[] = [];
  for (const r of rows) {
    const anchor = r.last_service ?? r.sold_at;
    const reference = serviceDueDate(anchor, r.service_interval_months);
    if (!reference) continue;
    const state = serviceReminderState(reference, todayIso, leadDays);
    if (state === "ok") continue;
    reminders.push({
      serialId: r.serial_id,
      serialNumber: r.serial_number,
      itemName: r.item_name,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      lastServiceDate: r.last_service,
      referenceDate: reference,
      state,
    });
  }
  return reminders.sort((a, b) => a.referenceDate.localeCompare(b.referenceDate));
}

export const PRE_OWNED_SOURCES = ["customer_tradein", "direct_purchase", "consignment", "other"] as const;
export type PreOwnedSource = (typeof PRE_OWNED_SOURCES)[number];

export interface PreOwnedIntakeInput {
  businessId: string;
  serialId: string;
  conditionGrade: ConditionGrade;
  boxAndPapers: boolean;
  /** Where the piece came from; defaults to 'other' for a bare annotation. */
  source?: PreOwnedSource;
  /** The person/dealer it came from, when known. */
  partyId?: string | null;
  documentNo?: string | null;
  /** The agreed acquisition value (Rial, whole) — provenance for the value posted at receive. */
  purchaseValueRial?: number;
  /** ISO date; defaults to the branch's business-local today. */
  intakeDate?: string | null;
  authenticityVerified?: boolean;
  authenticityNotes?: string | null;
  serviceHistory?: string | null;
  productionYear?: number | null;
  accessories?: string | null;
  notes?: string | null;
  /** Photo/document references (URLs or storage keys). */
  media?: string[];
  createdBy?: string | null;
}

export interface PreOwnedIntakeRecord {
  id: string;
  serialId: string;
  source: PreOwnedSource;
  partyId: string | null;
  partyName: string | null;
  documentNo: string | null;
  purchaseValueRial: number;
  intakeDate: string;
  conditionGrade: string;
  boxAndPapers: boolean;
  authenticityVerified: boolean;
  authenticityNotes: string | null;
  serviceHistory: string | null;
  productionYear: number | null;
  accessories: string | null;
  notes: string | null;
  media: string[];
  createdAt: string;
}

/**
 * Issue #795 item 18 — records a pre-owned intake as a full provenance
 * document (source, party, document, value, date, condition, box & papers,
 * authenticity, service history, year, accessories, notes, media, creator)
 * and mirrors the condition/box flags onto the serial for the unit board.
 *
 * Lifecycle: only a unit actually IN the shop's hands can be taken in —
 * a sold or written-off unit is somebody else's property / gone.
 *
 * Accounting: deliberately none here. The acquisition's inventory/AP
 * posting happened when the unit entered stock (receiveItemPurchase, the
 * single mutation path for new serials); the intake row documents that
 * value, and a second posting would double-count the same acquisition.
 */
export async function recordPreOwnedIntake(input: PreOwnedIntakeInput): Promise<PreOwnedIntakeRecord> {
  const gradeError = validateConditionGrade(input.conditionGrade);
  if (gradeError) throw new Error(gradeError);
  const source = input.source ?? "other";
  if (!PRE_OWNED_SOURCES.includes(source)) throw new Error("منبع دریافت نامعتبر است.");
  const purchaseValueRial = input.purchaseValueRial ?? 0;
  if (!Number.isInteger(purchaseValueRial) || purchaseValueRial < 0) {
    throw new Error("ارزش خرید باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }
  if (
    input.productionYear != null &&
    (!Number.isInteger(input.productionYear) || input.productionYear < 1900 || input.productionYear > 2100)
  ) {
    throw new Error("سال ساخت نامعتبر است.");
  }
  if (input.intakeDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(input.intakeDate)) {
    throw new Error("تاریخ دریافت نامعتبر است.");
  }

  const { rows: serialRows } = await query<{ status: string; location_id: string }>(
    `SELECT s.status, i.location_id FROM item_serials s JOIN items i ON i.id = s.item_id WHERE s.id = $1`,
    [input.serialId],
  );
  if (!serialRows[0]) throw new Error("سریال یافت نشد.");
  if (serialRows[0].status === "sold" || serialRows[0].status === "written_off") {
    throw new Error("فقط دستگاهی که در اختیار فروشگاه است قابل ثبت دست‌دوم است.");
  }
  const locationId = serialRows[0].location_id;

  let intakeDate = input.intakeDate ?? null;
  if (!intakeDate) {
    const { rows: dayRows } = await query<{ today: string }>(
      `SELECT app_business_date(now(), coalesce(timezone, 'Asia/Tehran'), business_day_start_minutes)::text AS today
         FROM locations WHERE id = $1`,
      [locationId],
    );
    intakeDate = dayRows[0]?.today ?? new Date().toISOString().slice(0, 10);
  }

  const { rows } = await query<{ id: string; created_at: string; party_name: string | null }>(
    `WITH inserted AS (
       INSERT INTO serial_preowned_intakes
         (business_id, location_id, serial_id, source, party_id, document_no, purchase_value_rial,
          intake_date, condition_grade, box_and_papers, authenticity_verified, authenticity_notes,
          service_history, production_year, accessories, notes, media, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id, party_id, created_at::text AS created_at
     )
     SELECT inserted.id, inserted.created_at, p.name AS party_name
       FROM inserted LEFT JOIN parties p ON p.id = inserted.party_id`,
    [
      input.businessId,
      locationId,
      input.serialId,
      source,
      input.partyId ?? null,
      input.documentNo?.trim() || null,
      purchaseValueRial,
      intakeDate,
      input.conditionGrade,
      input.boxAndPapers,
      input.authenticityVerified ?? false,
      input.authenticityNotes?.trim() || null,
      input.serviceHistory?.trim() || null,
      input.productionYear ?? null,
      input.accessories?.trim() || null,
      input.notes?.trim() || null,
      JSON.stringify(input.media ?? []),
      input.createdBy ?? null,
    ],
  );
  await query(
    `UPDATE item_serials SET condition_grade = $2, box_and_papers = $3, pre_owned = true WHERE id = $1`,
    [input.serialId, input.conditionGrade, input.boxAndPapers],
  );
  return {
    id: rows[0].id,
    serialId: input.serialId,
    source,
    partyId: input.partyId ?? null,
    partyName: rows[0].party_name,
    documentNo: input.documentNo?.trim() || null,
    purchaseValueRial,
    intakeDate,
    conditionGrade: input.conditionGrade,
    boxAndPapers: input.boxAndPapers,
    authenticityVerified: input.authenticityVerified ?? false,
    authenticityNotes: input.authenticityNotes?.trim() || null,
    serviceHistory: input.serviceHistory?.trim() || null,
    productionYear: input.productionYear ?? null,
    accessories: input.accessories?.trim() || null,
    notes: input.notes?.trim() || null,
    media: input.media ?? [],
    createdAt: rows[0].created_at,
  };
}

/** The latest intake document for a unit — what the provenance panel shows. */
export async function latestPreOwnedIntake(serialId: string): Promise<PreOwnedIntakeRecord | null> {
  const { rows } = await query<{
    id: string;
    serial_id: string;
    source: PreOwnedSource;
    party_id: string | null;
    party_name: string | null;
    document_no: string | null;
    purchase_value_rial: string;
    intake_date: string;
    condition_grade: string;
    box_and_papers: boolean;
    authenticity_verified: boolean;
    authenticity_notes: string | null;
    service_history: string | null;
    production_year: number | null;
    accessories: string | null;
    notes: string | null;
    media: string[];
    created_at: string;
  }>(
    `SELECT t.id, t.serial_id, t.source, t.party_id, p.name AS party_name, t.document_no,
            t.purchase_value_rial::text AS purchase_value_rial, t.intake_date::text AS intake_date,
            t.condition_grade, t.box_and_papers, t.authenticity_verified, t.authenticity_notes,
            t.service_history, t.production_year, t.accessories, t.notes, t.media,
            t.created_at::text AS created_at
       FROM serial_preowned_intakes t LEFT JOIN parties p ON p.id = t.party_id
      WHERE t.serial_id = $1
      ORDER BY t.created_at DESC LIMIT 1`,
    [serialId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    serialId: r.serial_id,
    source: r.source,
    partyId: r.party_id,
    partyName: r.party_name,
    documentNo: r.document_no,
    purchaseValueRial: Number(r.purchase_value_rial),
    intakeDate: r.intake_date,
    conditionGrade: r.condition_grade,
    boxAndPapers: r.box_and_papers,
    authenticityVerified: r.authenticity_verified,
    authenticityNotes: r.authenticity_notes,
    serviceHistory: r.service_history,
    productionYear: r.production_year,
    accessories: r.accessories,
    notes: r.notes,
    media: Array.isArray(r.media) ? r.media : [],
    createdAt: r.created_at,
  };
}

interface RepairEstimateRecord {
  ticketId: string;
  estimatedLaborRial: number;
  estimatedPartsRial: number;
  estimatedDiscountRial: number;
  estimatedVatRial: number;
  estimatedTotalRial: number;
  version: number;
  approvedAt: string | null;
  approvedVersion: number | null;
}

/**
 * Records (or replaces) the estimate on an open ticket — the full financial
 * document the customer will be asked to approve: labour, parts, an agreed
 * discount, VAT at the ticket's own rate (the same engine the close bills
 * with — issue #795 item 11), and the payable total. Each re-stamp is a new
 * estimate VERSION and clears any prior approval: a changed number is a new
 * document to approve.
 */
export async function setRepairEstimate(
  ticketId: string,
  input: { laborRial: number; partsRial: number; discountRial?: number },
): Promise<RepairEstimateRecord> {
  const { laborRial, partsRial } = input;
  const discountRial = input.discountRial ?? 0;
  const { rows } = await query<{ status: string; vat_percent: string }>(
    `SELECT status::text, vat_percent::text FROM repair_tickets WHERE id = $1`,
    [ticketId],
  );
  if (!rows[0]) throw new Error("تیکت یافت نشد.");
  if (rows[0].status === "closed" || rows[0].status === "cancelled") {
    throw new Error("تیکت بسته‌شده یا لغوشده را نمی‌توان برآورد کرد.");
  }

  // The estimate's VAT comes from the ticket's own rate, computed by the
  // exact engine closeRepairTicket bills with — so the number the customer
  // signs is the number the shop will charge.
  const breakdown = computeRepairCharge({
    laborCharge: laborRial,
    partsCharge: partsRial,
    discount: discountRial,
    vatPercent: Number(rows[0].vat_percent),
  });
  const { rows: updated } = await query<{ estimate_version: number }>(
    `UPDATE repair_tickets
        SET estimated_total_rial = $2, estimated_labor_rial = $3, estimated_parts_rial = $4,
            estimated_discount_rial = $5, estimated_vat_rial = $6,
            estimate_version = estimate_version + 1,
            estimated_at = now(), estimate_approved_at = NULL, estimate_approved_version = NULL,
            updated_at = now()
      WHERE id = $1 RETURNING estimate_version`,
    [ticketId, Number(breakdown.total), laborRial, partsRial, discountRial, Number(breakdown.vat)],
  );
  return {
    ticketId,
    estimatedLaborRial: laborRial,
    estimatedPartsRial: partsRial,
    estimatedDiscountRial: discountRial,
    estimatedVatRial: Number(breakdown.vat),
    estimatedTotalRial: Number(breakdown.total),
    version: updated[0].estimate_version,
    approvedAt: null,
    approvedVersion: null,
  };
}

/**
 * The customer's approval: stamps the ticket with the time AND the exact
 * estimate version being approved, so closeRepairTicket can verify the
 * signature still covers the current numbers.
 */
export async function approveRepairEstimate(ticketId: string): Promise<RepairEstimateRecord> {
  const { rows } = await query<{
    status: string;
    estimated_labor_rial: string;
    estimated_parts_rial: string;
    estimated_discount_rial: string;
    estimated_vat_rial: string;
    estimated_total_rial: string;
    estimate_version: number;
  }>(
    `SELECT status::text, estimated_labor_rial::text, estimated_parts_rial::text,
            estimated_discount_rial::text, estimated_vat_rial::text,
            estimated_total_rial::text, estimate_version
       FROM repair_tickets WHERE id = $1`,
    [ticketId],
  );
  if (!rows[0]) throw new Error("تیکت یافت نشد.");
  if (rows[0].status === "closed" || rows[0].status === "cancelled") {
    throw new Error("تیکت بسته‌شده یا لغوشده را نمی‌توان تأیید کرد.");
  }
  if (Number(rows[0].estimated_total_rial) <= 0) {
    throw new Error("این تیکت برآورد هزینه ندارد.");
  }

  const { rows: updated } = await query<{
    estimate_approved_at: string | null;
    estimate_approved_version: number | null;
  }>(
    `UPDATE repair_tickets
        SET estimate_approved_at = now(), estimate_approved_version = estimate_version, updated_at = now()
      WHERE id = $1 RETURNING estimate_approved_at, estimate_approved_version`,
    [ticketId],
  );
  return {
    ticketId,
    estimatedLaborRial: Number(rows[0].estimated_labor_rial),
    estimatedPartsRial: Number(rows[0].estimated_parts_rial),
    estimatedDiscountRial: Number(rows[0].estimated_discount_rial),
    estimatedVatRial: Number(rows[0].estimated_vat_rial),
    estimatedTotalRial: Number(rows[0].estimated_total_rial),
    version: rows[0].estimate_version,
    approvedAt: updated[0].estimate_approved_at,
    approvedVersion: updated[0].estimate_approved_version,
  };
}

interface EstimateRow extends Record<string, unknown> {
  ticket_number: string;
  item_description: string;
  reported_issue: string | null;
  estimated_labor_rial: string;
  estimated_parts_rial: string;
  estimated_discount_rial: string;
  estimated_vat_rial: string;
  estimated_total_rial: string;
  customer_name: string | null;
}

/** Renders the printable estimate for a ticket's current estimate. */
export async function repairEstimateText(
  ticketId: string,
  todayIso: string,
  unit: MoneyUnit = "toman",
): Promise<string> {
  const { rows } = await query<EstimateRow>(
    `SELECT t.ticket_number::text AS ticket_number, t.item_description, t.reported_issue,
            t.estimated_labor_rial::text AS estimated_labor_rial,
            t.estimated_parts_rial::text AS estimated_parts_rial,
            t.estimated_discount_rial::text AS estimated_discount_rial,
            t.estimated_vat_rial::text AS estimated_vat_rial,
            t.estimated_total_rial::text AS estimated_total_rial, c.name AS customer_name
       FROM repair_tickets t LEFT JOIN parties c ON c.id = t.customer_id
      WHERE t.id = $1`,
    [ticketId],
  );
  if (!rows[0]) throw new Error("تیکت یافت نشد.");
  return renderRepairEstimate({
    ticketNumber: Number(rows[0].ticket_number),
    itemDescription: rows[0].item_description,
    reportedIssue: rows[0].reported_issue,
    laborCharge: Number(rows[0].estimated_labor_rial),
    partsCharge: Number(rows[0].estimated_parts_rial),
    discountRial: Number(rows[0].estimated_discount_rial),
    vatRial: Number(rows[0].estimated_vat_rial),
    estimatedTotalRial: Number(rows[0].estimated_total_rial),
    customerName: rows[0].customer_name,
    todayIso,
    unit,
  });
}
