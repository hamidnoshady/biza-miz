import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ permission: vi.fn(), location: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: mocks.permission }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: mocks.location }));
vi.mock("@/lib/data-transfer/historical-invoice-archive-service", () => ({ listHistoricalInvoices: mocks.list }));
import { GET } from "./route";

const id = "8a86d451-f018-4bc9-bcb1-e04bcd96c91c";
const request = (query = "", customerId = id) => [new NextRequest(`http://localhost/api/crm/customers/${customerId}/historical-invoices${query}`), { params: Promise.resolve({ id: customerId }) }] as const;

beforeEach(() => {
  mocks.permission.mockReset().mockResolvedValue({ session: { businessId: "biz" }, error: null });
  mocks.location.mockReset().mockResolvedValue({ id: "active-branch" });
  mocks.list.mockReset().mockResolvedValue([]);
});

describe("customer historical invoice history", () => {
  it("enforces the customer permission and the active branch, ignoring location query parameters", async () => {
    const response = await GET(...request("?locationId=other&q=old&offset=50"));
    expect(response.status).toBe(200);
    expect(mocks.permission).toHaveBeenCalledWith("parties.view");
    expect(mocks.list).toHaveBeenCalledWith({ businessId: "biz", locationId: "active-branch", partyId: id, search: "old", limit: 51, offset: 50 });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("rejects unauthorized access, invalid customers and missing branches before a read", async () => {
    mocks.permission.mockResolvedValueOnce({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    expect((await GET(...request())).status).toBe(403);
    expect((await GET(...request("", "not-uuid"))).status).toBe(404);
    mocks.location.mockResolvedValueOnce(null);
    expect((await GET(...request())).status).toBe(409);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("caps page output and reports whether another page exists", async () => {
    mocks.list.mockResolvedValueOnce(Array.from({ length: 51 }, (_, index) => ({ id: String(index) })));
    const response = await GET(...request());
    const body = await response.json();
    expect(body.invoices).toHaveLength(50);
    expect(body.hasMore).toBe(true);
  });
});
