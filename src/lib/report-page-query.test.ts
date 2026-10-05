import { afterEach, describe, expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
vi.mock("./db", () => ({ query: read }));
import { queryReportPage } from "./report-page-query";
afterEach(() => vi.resetAllMocks());
describe("SQL report pages", () => {
  it("binds page and limit, preserves parameter ordering, and removes internal metadata", async () => {
    read.mockResolvedValue({ rows: [{ id: "last", _report_present: true, _report_total: "101", _report_summary: { amount: 10000 } }] });
    const result = await queryReportPage("SELECT id FROM example WHERE tenant=$1", ["tenant-a"], { page: 999999, orderBy: "id" });
    expect(result).toEqual({ rows: [{ id: "last" }], total: 101, summary: { amount: 10000 }, pagination: { page: 3, pageSize: 50, pages: 3, total: 101 } });
    expect(read).toHaveBeenCalledTimes(1);
    const [sql, params] = read.mock.calls[0];
    expect(sql).toContain("LIMIT $2::int"); expect(sql).toContain("$3::bigint - 1");
    expect(sql).toContain("LEFT JOIN LATERAL"); expect(sql).toContain("FROM report_source");
    expect(params).toEqual(["tenant-a", 50, 999999]);
  });
  it("keeps the empty-source totals row out of the detail array", async () => {
    read.mockResolvedValue({ rows: [{ id: null, _report_present: null, _report_total: "0", _report_summary: {} }] });
    expect(await queryReportPage("SELECT id FROM example", [], { page: 2, orderBy: "id" })).toEqual({
      rows: [], total: 0, summary: {}, pagination: { page: 1, pageSize: 50, pages: 1, total: 0 },
    });
  });
  it("retains an unlimited legacy mode only when no page was requested", async () => {
    read.mockResolvedValue({ rows: [{ id: "one", _report_present: true, _report_total: "1", _report_summary: {} }] });
    expect((await queryReportPage("SELECT id FROM example", [], { orderBy: "id" })).pagination).toBeNull();
    expect(read.mock.calls[0][1]).toEqual([null, 1]);
  });
});
