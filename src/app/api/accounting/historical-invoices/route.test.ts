import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ permission: vi.fn(), location: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: mocks.permission }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: mocks.location }));
vi.mock("@/lib/data-transfer/historical-invoice-archive-service", () => ({ listHistoricalInvoices: mocks.list }));
import { GET } from "./route";

beforeEach(() => {
  mocks.permission.mockReset().mockResolvedValue({ session: { businessId: "biz" }, error: null });
  mocks.location.mockReset().mockResolvedValue({ id: "branch" });
  mocks.list.mockReset().mockResolvedValue([]);
});
describe("accounting historical invoice archive", () => {
  it("uses sales permission and the active branch, not a requested branch", async () => {
    const response = await GET(new NextRequest("http://localhost/api/accounting/historical-invoices?locationId=other&q=123&offset=50"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.permission).toHaveBeenCalledWith("orders.view");
    expect(mocks.list).toHaveBeenCalledWith({ businessId: "biz", locationId: "branch", search: "123", limit: 51, offset: 50 });
  });
  it("does not read for an unauthorized member or without an accessible branch", async () => {
    mocks.permission.mockResolvedValueOnce({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    expect((await GET(new NextRequest("http://localhost/api/accounting/historical-invoices"))).status).toBe(403);
    mocks.location.mockResolvedValueOnce(null);
    expect((await GET(new NextRequest("http://localhost/api/accounting/historical-invoices"))).status).toBe(409);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
