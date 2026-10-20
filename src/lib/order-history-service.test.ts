import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseOrderHistoryFilters } from "./order-history";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./db", () => ({ query: db.query }));

import { listOrderHistory } from "./order-history-service";

const LOCATION_ID = "11111111-1111-4111-8111-111111111111";
const BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const SHIFT_ID = "33333333-3333-4333-8333-333333333333";

function filters(query = "") {
  const result = parseOrderHistoryFilters(new URLSearchParams(query));
  if (!result.ok) throw new Error(result.error);
  return result.filters;
}

function rows(rows: unknown[] = []) {
  return { rows };
}

describe("order history query service", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockImplementation(async () => rows());
  });

  it("keeps the result branch-scoped, uses branch-local dates, and bounds stable pagination", async () => {
    await listOrderHistory({
      businessId: BUSINESS_ID,
      locationId: LOCATION_ID,
      timeZone: "America/New_York",
      filters: filters("q=42&page=2&pageSize=10&from=2026-01-01&to=2026-01-31"),
      canReviewShifts: false,
    });

    const [ordersSql, ordersParams] = db.query.mock.calls[0] as [string, unknown[]];
    expect(ordersSql).toContain("WHERE o.location_id=$1");
    expect(ordersSql).toContain("ORDER BY o.opened_at DESC, o.id DESC");
    expect(ordersSql).toContain("(o.opened_at AT TIME ZONE $3)::date");
    expect(ordersSql).toContain("LIMIT $11 OFFSET $12");
    expect(ordersParams.slice(0, 5)).toEqual([
      LOCATION_ID,
      BUSINESS_ID,
      "America/New_York",
      "2026-01-01",
      "2026-01-31",
    ]);
    expect(ordersParams.slice(-2)).toEqual([10, 10]);
  });

  it("assigns shift membership by opened_at and only lists shift options for authorized reviewers", async () => {
    await listOrderHistory({
      businessId: BUSINESS_ID,
      locationId: LOCATION_ID,
      timeZone: "Asia/Tehran",
      filters: filters(`shiftId=${SHIFT_ID}&from=2026-01-01&to=2026-01-31`),
      canReviewShifts: true,
    });

    const sqlStatements = db.query.mock.calls.map(([sql]) => String(sql));
    expect(sqlStatements[0]).toContain("o.opened_at >= s.started_at");
    expect(sqlStatements[0]).toContain("o.opened_at <= s.ended_at");
    expect(sqlStatements.some((sql) => sql.includes("JOIN users u ON u.id=s.employee_id"))).toBe(true);
    const shiftCall = db.query.mock.calls.find(([sql]) => String(sql).includes("JOIN users u ON u.id=s.employee_id"));
    expect(String(shiftCall?.[0])).toContain("COALESCE(s.ended_at, now())");
    expect(String(shiftCall?.[0])).toContain("ORDER BY (s.id=$6::uuid) DESC");
    expect(shiftCall?.[1]).toEqual([BUSINESS_ID, LOCATION_ID, "2026-01-01", "2026-01-31", "Asia/Tehran", SHIFT_ID]);

    db.query.mockReset();
    db.query.mockImplementation(async () => rows());
    await listOrderHistory({
      businessId: BUSINESS_ID,
      locationId: LOCATION_ID,
      timeZone: "Asia/Tehran",
      filters: filters(),
      canReviewShifts: false,
    });
    expect(db.query.mock.calls.map(([sql]) => String(sql)).some((sql) => sql.includes("JOIN users u ON u.id=s.employee_id"))).toBe(false);
  });
});
