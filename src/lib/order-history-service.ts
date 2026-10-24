import { query } from "./db";
import { shiftInBranchSql } from "./shift-branch-scope";
import { normalizePosSearchText } from "./pos-selection";
import type { OrderHistoryFilters } from "./order-history";

export interface OrderHistoryRow {
  id: string;
  order_number: string;
  type: "dine_in" | "takeaway" | "delivery";
  status: "open" | "held" | "completed" | "voided";
  table_id: string | null;
  table_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  total: string;
  opened_at: string;
  closed_at: string | null;
}

export interface OrderHistoryResult {
  orders: OrderHistoryRow[];
  page: number;
  pageSize: number;
  pageCount: number;
  totalCount: number;
  statusCounts: Record<"open" | "held" | "completed" | "voided", number>;
  tables: { id: string; name: string }[];
  shifts: { id: string; employeeName: string; startedAt: string; endedAt: string | null }[];
}

interface DbOrderHistoryRow extends Record<string, unknown> {
  id: string;
  order_number: string;
  type: OrderHistoryRow["type"];
  status: OrderHistoryRow["status"];
  table_id: string | null;
  table_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  total: string;
  opened_at: Date | string;
  closed_at: Date | string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function escapedLike(value: string): string {
  return `%${normalizePosSearchText(value).replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function historyWhere(filters: OrderHistoryFilters, includeStatus: boolean): { sql: string; params: unknown[] } {
  const search = filters.search ? escapedLike(filters.search) : null;
  const params: unknown[] = [
    "", // $1 location id is filled by the caller.
    "", // $2 business id is filled by the caller.
    "Asia/Tehran", // $3 branch timezone is filled by the caller.
    filters.from,
    filters.to,
    includeStatus ? filters.status : null,
    filters.type,
    filters.tableId,
    filters.shiftId,
    search,
  ];
  return {
    sql: `o.location_id=$1
      AND ($4::date IS NULL OR (o.opened_at AT TIME ZONE $3)::date >= $4::date)
      AND ($5::date IS NULL OR (o.opened_at AT TIME ZONE $3)::date <= $5::date)
      AND ($6::text IS NULL OR o.status::text=$6)
      AND ($7::text IS NULL OR o.type::text=$7)
      AND ($8::uuid IS NULL OR o.table_id=$8::uuid)
      AND ($9::uuid IS NULL OR EXISTS (
        SELECT 1 FROM employee_shifts s
         WHERE s.id=$9::uuid AND s.business_id=$2
           AND ${shiftInBranchSql("s", "$1")}
           AND o.opened_at >= s.started_at
           AND (s.ended_at IS NULL OR o.opened_at <= s.ended_at)
      ))
      AND ($10::text IS NULL OR (
        o.order_number::text ILIKE $10 ESCAPE E'\\\\'
        OR COALESCE(c.name,'') ILIKE $10 ESCAPE E'\\\\'
        OR COALESCE(c.phone,'') ILIKE $10 ESCAPE E'\\\\'
        OR COALESCE(dt.name,'') ILIKE $10 ESCAPE E'\\\\'
      ))`,
    params,
  };
}

/** Complete, branch-scoped, indexed/searchable order history with stable pagination. */
export async function listOrderHistory(input: {
  businessId: string;
  locationId: string;
  timeZone: string;
  filters: OrderHistoryFilters;
  canReviewShifts: boolean;
}): Promise<OrderHistoryResult> {
  const { filters } = input;
  const pageOffset = (filters.page - 1) * filters.pageSize;

  const buildParams = (includeStatus: boolean) => {
    const built = historyWhere(filters, includeStatus);
    built.params[0] = input.locationId;
    built.params[1] = input.businessId;
    built.params[2] = input.timeZone;
    return built;
  };
  const filtered = buildParams(true);
  filtered.params.push(filters.pageSize, pageOffset);
  const allStatuses = buildParams(false);

  const [ordersResult, countResult, tableResult, shiftResult] = await Promise.all([
    query<DbOrderHistoryRow>(
      `SELECT o.id, o.order_number::text, o.type::text, o.status::text,
              o.table_id, dt.name AS table_name, o.customer_id,
              c.name AS customer_name, c.phone AS customer_phone,
              o.total::text, o.opened_at, o.closed_at
         FROM orders o
         LEFT JOIN dining_tables dt ON dt.id=o.table_id
         LEFT JOIN parties c ON c.id=o.customer_id
        WHERE ${filtered.sql}
        ORDER BY o.opened_at DESC, o.id DESC
        LIMIT $11 OFFSET $12`,
      filtered.params,
    ),
    query<{
      total_count: string;
      open_count: string;
      held_count: string;
      completed_count: string;
      voided_count: string;
    }>(
      `SELECT count(*)::text AS total_count,
              count(*) FILTER (WHERE o.status='open')::text AS open_count,
              count(*) FILTER (WHERE o.status='held')::text AS held_count,
              count(*) FILTER (WHERE o.status='completed')::text AS completed_count,
              count(*) FILTER (WHERE o.status='voided')::text AS voided_count
         FROM orders o
         LEFT JOIN dining_tables dt ON dt.id=o.table_id
         LEFT JOIN parties c ON c.id=o.customer_id
        WHERE ${allStatuses.sql}`,
      allStatuses.params,
    ),
    query<{ id: string; name: string }>(
      `SELECT id, name FROM dining_tables
        WHERE location_id=$1
        ORDER BY name, id`,
      [input.locationId],
    ),
    input.canReviewShifts
      ? query<{ id: string; employee_name: string; started_at: Date | string; ended_at: Date | string | null }>(
          `SELECT s.id, u.full_name AS employee_name, s.started_at, s.ended_at
             FROM employee_shifts s
             JOIN users u ON u.id=s.employee_id AND u.business_id=s.business_id
            WHERE s.business_id=$1 AND ${shiftInBranchSql("s", "$2")}
              AND (
                (
                  ($3::date IS NULL OR COALESCE(s.ended_at, now()) >= ($3::date::timestamp AT TIME ZONE $5))
                  AND ($4::date IS NULL OR s.started_at < (($4::date + 1)::timestamp AT TIME ZONE $5))
                )
                OR s.id=$6::uuid
              )
            ORDER BY (s.id=$6::uuid) DESC, s.started_at DESC, s.id DESC
            LIMIT 250`,
          [input.businessId, input.locationId, filters.from, filters.to, input.timeZone, filters.shiftId],
        )
      : Promise.resolve({ rows: [] as { id: string; employee_name: string; started_at: Date | string; ended_at: Date | string | null }[] }),
  ]);

  const count = countResult.rows[0];
  const totalCount = Number(count?.total_count ?? 0);
  return {
    orders: ordersResult.rows.map((row) => ({
      id: row.id,
      order_number: row.order_number,
      type: row.type,
      status: row.status,
      table_id: row.table_id,
      table_name: row.table_name,
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      customer_phone: row.customer_phone,
      total: row.total,
      opened_at: iso(row.opened_at)!,
      closed_at: iso(row.closed_at),
    })),
    page: filters.page,
    pageSize: filters.pageSize,
    pageCount: Math.max(1, Math.ceil(totalCount / filters.pageSize)),
    totalCount,
    statusCounts: {
      open: Number(count?.open_count ?? 0),
      held: Number(count?.held_count ?? 0),
      completed: Number(count?.completed_count ?? 0),
      voided: Number(count?.voided_count ?? 0),
    },
    tables: tableResult.rows,
    shifts: shiftResult.rows.map((shift) => ({
      id: shift.id,
      employeeName: shift.employee_name,
      startedAt: iso(shift.started_at)!,
      endedAt: iso(shift.ended_at),
    })),
  };
}
