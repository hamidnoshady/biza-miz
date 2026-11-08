import { NextRequest, NextResponse } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ permission: vi.fn(), location: vi.fn(), lines: vi.fn() }));
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: mocks.permission }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: mocks.location }));
vi.mock("@/lib/data-transfer/historical-invoice-archive-service", () => ({ listHistoricalInvoiceLines: mocks.lines }));
import { GET } from "./route";
const invoiceId = "e225ee77-16de-43f2-89b3-00f6e9ee3a23";
const req = () => [new NextRequest("http://localhost/details?offset=20&locationId=other"), { params: Promise.resolve({ invoiceId }) }] as const;
beforeEach(() => {
  mocks.permission.mockReset().mockResolvedValue({ session: { businessId: "biz" }, error: null });
  mocks.location.mockReset().mockResolvedValue({ id: "branch" });
  mocks.lines.mockReset().mockResolvedValue({ lines: [], hasMore: false });
});
it("requires sales access and scopes details to the active branch", async () => {
  const response = await GET(...req());
  expect(response.status).toBe(200);
  expect(mocks.permission).toHaveBeenCalledWith("orders.view");
  expect(mocks.lines).toHaveBeenCalledWith({ businessId: "biz", locationId: "branch", invoiceId, offset: 20 });
});
it("blocks permission failures and documents outside the scope", async () => {
  mocks.permission.mockResolvedValueOnce({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  expect((await GET(...req())).status).toBe(403);
  expect(mocks.lines).not.toHaveBeenCalled();
  mocks.lines.mockResolvedValueOnce(null);
  expect((await GET(...req())).status).toBe(404);
});
