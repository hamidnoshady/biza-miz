/** Server-side, branch-scoped order reporting for the shift-orders report. */
import { query } from "./db";
import { ORDER_OPENED_IN_WINDOW } from "./order-read-service";
import { normalizePosSearchText } from "./pos-selection";
import type { ReportOrderFilters } from "./report-order-filters";
import {
  groupShiftOrders,
  type ShiftOrder,
  type ShiftOrderItemInput,
  type ShiftOrderModifier,
  type ShiftOrderPaymentInput,
} from "./shift-orders";

export interface ShiftOption {
  id: string;
  employeeName: string;
  startedAt: string;
  endedAt: string | null;
}

interface ShiftWindowRow extends Record<string, unknown> {
  id: string; employee_name: string; started_at: Date; ended_at: Date | null;
}

function shiftFromRow(row: ShiftWindowRow): ShiftOption {
  return { id: row.id, employeeName: row.employee_name, startedAt: row.started_at.toISOString(), endedAt: row.ended_at?.toISOString() ?? null };
}

/** Recent picker options. Retained for the orders screen and legacy callers. */
export async function listRecentShiftOptions(locationId: string, limit = 50): Promise<ShiftOption[]> {
  const { rows } = await query<ShiftWindowRow>(
    `SELECT s.id, u.full_name AS employee_name, s.started_at, s.ended_at
       FROM employee_shifts s JOIN users u ON u.id = s.employee_id
      WHERE (s.location_id = $1 OR s.location_id IS NULL)
      ORDER BY s.started_at DESC, s.id DESC LIMIT $2`, [locationId, limit]);
  return rows.map(shiftFromRow);
}

async function resolveShift(locationId: string, shiftId?: string): Promise<ShiftOption | null> {
  const params: unknown[] = [locationId];
  const idClause = shiftId ? (params.push(shiftId), `AND s.id = $2`) : "";
  const { rows } = await query<ShiftWindowRow>(
    `SELECT s.id, u.full_name AS employee_name, s.started_at, s.ended_at
       FROM employee_shifts s JOIN users u ON u.id = s.employee_id
      WHERE (s.location_id = $1 OR s.location_id IS NULL) ${idClause}
      ORDER BY s.started_at DESC, s.id DESC LIMIT 1`, params);
  return rows[0] ? shiftFromRow(rows[0]) : null;
}

/** Date-scoped options make an old custom period selectable without loading years of shifts. */
async function listReportShiftOptions(locationId: string, filters: ReportOrderFilters, selected: ShiftOption | null) {
  if (!filters.dateFrom && !filters.dateTo) {
    const recent = await listRecentShiftOptions(locationId);
    return selected && !recent.some((s) => s.id === selected.id) ? [selected, ...recent] : recent;
  }
  const params: unknown[] = [locationId, filters.dateFrom ?? null, filters.dateTo ?? null, filters.timeZone ?? "Asia/Tehran"];
  const { rows } = await query<ShiftWindowRow>(
    `SELECT s.id, u.full_name AS employee_name, s.started_at, s.ended_at
       FROM employee_shifts s JOIN users u ON u.id = s.employee_id
      WHERE (s.location_id = $1 OR s.location_id IS NULL)
        AND ($2::date IS NULL OR coalesce(s.ended_at, now()) >= ($2::date::timestamp AT TIME ZONE $4))
        AND ($3::date IS NULL OR s.started_at < ((($3::date + 1)::timestamp) AT TIME ZONE $4))
      ORDER BY s.started_at DESC, s.id DESC`, params);
  const options = rows.map(shiftFromRow);
  return selected && !options.some((s) => s.id === selected.id) ? [selected, ...options] : options;
}

/**
 * What the list actually covers (audit F18), so the screen can say it:
 * one shift; every order; only orders outside every shift; or every order
 * because the branch has never recorded a shift — the case that used to
 * answer «شیفت پیدا نشد» to a shop that sells only online.
 */
export type ShiftOrdersScope = "shift" | "all_shifts" | "unassigned" | "no_shift_recorded";

/**
 * The headline numbers, split by what they actually mean (issue #819).
 *
 * `totalAmount` was everything the filter matched — open, held, completed and
 * voided orders added together — and the screen called it «جمع», so a shift
 * with a voided bill and two open tables read as if that money had been taken.
 * A voided order keeps its historical total, so the sum of `o.total` over
 * mixed statuses is not sales at any point in the order's life.
 *
 * Three questions, three answers:
 *   matchingCount  — how many orders the filters matched (face value).
 *   completed*     — settled sales: the only figure that is revenue.
 *   open/held*     — order value still on the floor, not yet taken.
 *   voided*        — value that never happened, kept for loss review.
 */
export interface ShiftOrdersSummary {
  matchingCount: number;
  completedCount: number;
  completedAmount: number;
  openCount: number;
  openAmount: number;
  heldCount: number;
  heldAmount: number;
  voidedCount: number;
  voidedAmount: number;
}

export interface ShiftOrdersReport {
  shift: ShiftOption | null;
  scope: ShiftOrdersScope;
  shifts: ShiftOption[];
  orders: ShiftOrder[];
  summary: ShiftOrdersSummary;
  /** How many orders the filter matched — same as `summary.matchingCount`. */
  totalCount: number;
  /**
   * Face value of every matched order, whatever its status. Kept because the
   * export and older callers read it, but no screen labels it «جمع» any more;
   * use `summary.completedAmount` for settled sales.
   */
  totalAmount: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

interface ShiftOrderItemRow extends Record<string, unknown> {
  order_id: string; order_number: string; type: string; status: string; table_name: string | null;
  guest_count: number | null; customer_name: string | null; opened_at: Date; closed_at: Date | null;
  opened_by_name: string | null; closed_by_name: string | null; order_note: string | null;
  voided_reason: string | null; amended_at: Date | null; subtotal: string; discount: string;
  discount_type: string | null; discount_value: string | null; service_charge: string; tax: string;
  tip_amount: string; order_total: string; item_id: string | null; item_name: string | null;
  quantity: number | null; unit_price: string | null;
  modifiers: { name: string; price_delta: string | number; quantity?: number }[] | null;
  item_status: string | null; note: string | null; void_reason: string | null;
}
interface ShiftOrderPaymentRow extends Record<string, unknown> {
  order_id: string; method: string; method_name: string | null; amount: string; reference: string | null;
  received_at: Date; received_by_name: string | null;
}

function escapedLike(value: string): string {
  return `%${normalizePosSearchText(value).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Reads full bills after first paging matching order ids. Thus LIMIT applies to orders, never joined
 * lines, and summaries are computed over the complete filtered set. Shift membership remains based
 * exclusively on opened_at. Date upper bounds are exclusive at the next local midnight.
 */
type ShiftSpecificOrdersReport = Omit<ShiftOrdersReport, "shift"> & { shift: ShiftOption };

/** Orders opened outside every shift window of the branch. */
const OPENED_OUTSIDE_EVERY_SHIFT = `NOT EXISTS (
  SELECT 1 FROM employee_shifts s
   WHERE (s.location_id = o.location_id OR s.location_id IS NULL)
     AND o.opened_at >= s.started_at AND (s.ended_at IS NULL OR o.opened_at <= s.ended_at))`;

export async function getShiftOrdersReport(locationId: string, shiftId: string): Promise<ShiftSpecificOrdersReport | null>;
export async function getShiftOrdersReport(locationId: string, filters?: ReportOrderFilters): Promise<ShiftOrdersReport | null>;
export async function getShiftOrdersReport(
  locationId: string,
  shiftIdOrFilters?: string | ReportOrderFilters,
): Promise<ShiftOrdersReport | null> {
  const filters: ReportOrderFilters = typeof shiftIdOrFilters === "string" ? { shiftId: shiftIdOrFilters } : (shiftIdOrFilters ?? {});
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 25)));
  // undefined means the newest shift; null explicitly means all shifts. A
  // branch that has never recorded a shift has no newest one, so the default
  // falls back to every order and says so, rather than reporting the absent
  // shift as missing.
  const selected = filters.shiftId === null ? null : await resolveShift(locationId, filters.shiftId);
  if (typeof filters.shiftId === "string" && !selected) return null;
  const scope: ShiftOrdersScope = selected
    ? "shift"
    : filters.unassigned
      ? "unassigned"
      : filters.shiftId === undefined
        ? "no_shift_recorded"
        : "all_shifts";
  const shifts = await listReportShiftOptions(locationId, filters, selected);

  const params: unknown[] = [locationId];
  const where = ["o.location_id = $1"];
  const add = (value: unknown) => (params.push(value), `$${params.length}`);
  if (selected) {
    // ORDER_OPENED_IN_WINDOW is shared with settled-order listing: orders stay
    // assigned to the shift that opened them, including carried-over bills.
    add(selected.startedAt);
    add(selected.endedAt);
    where.push(ORDER_OPENED_IN_WINDOW);
  }
  if (scope === "unassigned") where.push(OPENED_OUTSIDE_EVERY_SHIFT);
  const zone = filters.timeZone ?? "Asia/Tehran";
  if (filters.dateFrom) {
    const value = add(filters.dateFrom); const tz = add(zone);
    where.push(`o.opened_at >= (${value}::date::timestamp AT TIME ZONE ${tz})`);
  }
  if (filters.dateTo) {
    const value = add(filters.dateTo); const tz = add(zone);
    where.push(`o.opened_at < (((${value}::date + 1)::timestamp) AT TIME ZONE ${tz})`);
  }
  if (filters.orderNumber) where.push(`o.order_number = ${add(filters.orderNumber)}::bigint`);
  if (filters.customerQuery) {
    const pattern = add(escapedLike(filters.customerQuery));
    where.push(`regexp_replace(translate(coalesce(c.name, ''), 'يك٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', 'یک01234567890123456789'), '[ً-ٰٟ]', '', 'g') ILIKE ${pattern} ESCAPE '\\'`);
  }
  if (filters.status) where.push(`o.status = ${add(filters.status)}::order_status`);
  if (filters.type) where.push(`o.type = ${add(filters.type)}::order_type`);
  const predicate = where.join(" AND ");

  const limit = add(pageSize); const offset = add((page - 1) * pageSize);
  const [{ rows: idRows }, { rows: totals }] = await Promise.all([
    query<{ id: string }>(`SELECT o.id FROM orders o LEFT JOIN parties c ON c.id = o.customer_id WHERE ${predicate} ORDER BY o.opened_at DESC, o.id DESC LIMIT ${limit} OFFSET ${offset}`, params),
    query<{
      total_count: string; total_amount: string;
      completed_count: string; completed_amount: string;
      open_count: string; open_amount: string;
      held_count: string; held_amount: string;
      voided_count: string; voided_amount: string;
    }>(
      // One pass over the matched set, split by status with FILTER. The
      // headline a cashier reads is `completed_amount`; the rest is context
      // (what is still on the floor, what was voided) rather than one mixed
      // «جمع» that adds a voided bill to real revenue (issue #819).
      `SELECT count(*)::text AS total_count,
              coalesce(sum(o.total), 0)::text AS total_amount,
              count(*) FILTER (WHERE o.status = 'completed')::text AS completed_count,
              coalesce(sum(o.total) FILTER (WHERE o.status = 'completed'), 0)::text AS completed_amount,
              count(*) FILTER (WHERE o.status = 'open')::text AS open_count,
              coalesce(sum(o.total) FILTER (WHERE o.status = 'open'), 0)::text AS open_amount,
              count(*) FILTER (WHERE o.status = 'held')::text AS held_count,
              coalesce(sum(o.total) FILTER (WHERE o.status = 'held'), 0)::text AS held_amount,
              count(*) FILTER (WHERE o.status = 'voided')::text AS voided_count,
              coalesce(sum(o.total) FILTER (WHERE o.status = 'voided'), 0)::text AS voided_amount
         FROM orders o LEFT JOIN parties c ON c.id = o.customer_id WHERE ${predicate}`,
      params.slice(0, -2),
    ),
  ]);
  const ids = idRows.map((row) => row.id);
  const totalCount = Number(totals[0]?.total_count ?? 0);
  const totalAmount = Number(totals[0]?.total_amount ?? 0);
  const summary: ShiftOrdersSummary = {
    matchingCount: totalCount,
    completedCount: Number(totals[0]?.completed_count ?? 0),
    completedAmount: Number(totals[0]?.completed_amount ?? 0),
    openCount: Number(totals[0]?.open_count ?? 0),
    openAmount: Number(totals[0]?.open_amount ?? 0),
    heldCount: Number(totals[0]?.held_count ?? 0),
    heldAmount: Number(totals[0]?.held_amount ?? 0),
    voidedCount: Number(totals[0]?.voided_count ?? 0),
    voidedAmount: Number(totals[0]?.voided_amount ?? 0),
  };
  if (ids.length === 0) return { shift: selected, scope, shifts, orders: [], summary, totalCount, totalAmount, page, pageSize, pageCount: Math.ceil(totalCount / pageSize) };

  const [{ rows }, { rows: paymentRows }, { rows: onlineRows }] = await Promise.all([
    query<ShiftOrderItemRow>(
      `SELECT o.id AS order_id, o.order_number, o.type, o.status, dt.name AS table_name, o.guest_count,
              c.name AS customer_name, o.opened_at, o.closed_at, ou.full_name AS opened_by_name,
              cu.full_name AS closed_by_name, o.note AS order_note, o.voided_reason, o.amended_at,
              o.subtotal, o.discount, o.discount_type, o.discount_value, o.service_charge, o.tax,
              o.tip_amount, o.total AS order_total, oi.id AS item_id, oi.name_snapshot AS item_name,
              oi.quantity, oi.unit_price, oi.status AS item_status, oi.note, oi.void_reason, m.modifiers
         FROM orders o LEFT JOIN dining_tables dt ON dt.id=o.table_id LEFT JOIN parties c ON c.id=o.customer_id
         LEFT JOIN users ou ON ou.id=o.opened_by LEFT JOIN users cu ON cu.id=o.closed_by
         LEFT JOIN order_items oi ON oi.order_id=o.id
         LEFT JOIN LATERAL (SELECT json_agg(json_build_object('name', oim.name_snapshot, 'price_delta', oim.price_delta, 'quantity', oim.quantity) ORDER BY oim.name_snapshot) AS modifiers FROM order_item_modifiers oim WHERE oim.order_item_id=oi.id) m ON true
        WHERE o.location_id=$1 AND o.id=ANY($2::uuid[])
        ORDER BY o.opened_at DESC, o.id DESC, oi.created_at`, [locationId, ids]),
    query<ShiftOrderPaymentRow>(
      `SELECT p.order_id,p.method,pm.name AS method_name,p.amount,p.reference,p.received_at,u.full_name AS received_by_name
         FROM payments p JOIN orders o ON o.id=p.order_id LEFT JOIN users u ON u.id=p.received_by
         LEFT JOIN payment_methods pm ON pm.id=p.payment_method_id
        WHERE o.location_id=$1 AND o.id=ANY($2::uuid[]) ORDER BY p.received_at,p.id`, [locationId, ids]),
    query<{ order_id: string }>(
      `SELECT order_id FROM online_order_documents WHERE location_id=$1 AND order_id=ANY($2::uuid[])
       UNION SELECT order_id FROM online_sale_lines WHERE location_id=$1 AND order_id=ANY($2::uuid[])`, [locationId, ids]),
  ]);
  const online = new Set(onlineRows.map((row) => row.order_id));

  const inputs: ShiftOrderItemInput[] = rows.map((row) => ({
    orderId: row.order_id,
    orderNumber: BigInt(row.order_number) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(row.order_number) : row.order_number,
    type: row.type as ShiftOrderItemInput["type"], status: row.status, tableName: row.table_name,
    guestCount: row.guest_count === null ? null : Number(row.guest_count), customerName: row.customer_name,
    openedAt: row.opened_at.toISOString(), closedAt: row.closed_at?.toISOString() ?? null,
    openedByName: row.opened_by_name, closedByName: row.closed_by_name, orderNote: row.order_note,
    voidedReason: row.voided_reason, amendedAt: row.amended_at?.toISOString() ?? null,
    subtotal: Number(row.subtotal), discount: Number(row.discount), discountType: row.discount_type as ShiftOrderItemInput["discountType"],
    discountValue: row.discount_value === null ? null : Number(row.discount_value), serviceCharge: Number(row.service_charge),
    tax: Number(row.tax), tipAmount: Number(row.tip_amount ?? 0), orderTotal: Number(row.order_total), itemId: row.item_id,
    itemName: row.item_name, quantity: Number(row.quantity ?? 0), unitPrice: Number(row.unit_price ?? 0),
    modifiers: (row.modifiers ?? []).map((m): ShiftOrderModifier => ({ name: m.name, priceDelta: Number(m.price_delta), quantity: m.quantity })),
    itemStatus: row.item_status, note: row.note, voidReason: row.void_reason,
  }));
  const payments: ShiftOrderPaymentInput[] = paymentRows.map((row) => ({ orderId: row.order_id, method: row.method,
    methodName: row.method_name, amount: Number(row.amount), reference: row.reference,
    receivedAt: row.received_at.toISOString(), receivedByName: row.received_by_name }));
  const orders = groupShiftOrders(inputs, payments).map((order) => ({
    ...order,
    channel: online.has(order.id) ? ("online" as const) : ("in_store" as const),
  }));
  return { shift: selected, scope, shifts, orders, summary, totalCount, totalAmount, page, pageSize, pageCount: Math.ceil(totalCount / pageSize) };
}
