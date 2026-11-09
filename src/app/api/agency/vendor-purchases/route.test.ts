import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import { VendorPurchaseError } from "@/lib/agency-vendor-purchase";

const mock = vi.hoisted(() => ({ agencyOwner: vi.fn(), requirePermission: vi.fn(), list: vi.fn(), create: vi.fn(), submit: vi.fn(), book: vi.fn() }));
vi.mock("@/lib/auth", () => ({ withTenantScope: (fn: unknown) => fn, requirePermission: mock.requirePermission }));
vi.mock("../guard", async () => {
  const { PERMISSIONS } = await import("@/lib/permissions");
  const { NextResponse } = await import("next/server");
  return ({
  agencyOwner: mock.agencyOwner, PERMISSIONS,
  readBody: (req: NextRequest) => req.json(),
  handleAgencyError: () => NextResponse.json({ error: "unexpected" }, { status: 500 }),
}); });
vi.mock("@/lib/agency-vendor-purchase-service", () => ({
  listVendorPurchases: mock.list, createVendorPurchase: mock.create,
  submitVendorPurchase: mock.submit, bookVendorPurchase: mock.book,
}));
import { GET, POST } from "./route";
import { POST as action } from "./[id]/route";
const owner = { businessId: "business", actorUserId: "actor" };
const request = (body: unknown) => new NextRequest("http://test/api/agency/vendor-purchases", { method: "POST", body: JSON.stringify(body) });
const context = { params: Promise.resolve({ id: "purchase" }) };
beforeEach(() => {
  vi.clearAllMocks();
  mock.agencyOwner.mockResolvedValue({ owner, error: null });
  mock.requirePermission.mockResolvedValue({ error: null });
  mock.list.mockResolvedValue([]); mock.create.mockResolvedValue({ id: "new" });
  mock.submit.mockResolvedValue(undefined); mock.book.mockResolvedValue({ costId: "cost" });
});
describe("agency vendor purchase API boundaries", () => {
  it("passes only the authorized owner and the requested project to reads", async () => {
    expect((await GET(new NextRequest("http://test/api/agency/vendor-purchases?projectId=project"))).status).toBe(200);
    expect(mock.agencyOwner).toHaveBeenCalledWith(PERMISSIONS.workspaceView, expect.anything());
    expect(mock.list).toHaveBeenCalledWith(owner,"project");
  });
  it("refuses unauthenticated/industry/permission failures before touching the service", async () => {
    mock.agencyOwner.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    expect((await POST(request({}))).status).toBe(403);
    expect((await GET(new NextRequest("http://test/api/agency/vendor-purchases"))).status).toBe(403);
    expect((await action(request({ action: "book" }),context)).status).toBe(403);
    expect(mock.create).not.toHaveBeenCalled(); expect(mock.list).not.toHaveBeenCalled(); expect(mock.book).not.toHaveBeenCalled();
  });
  it("requires separate directory permission before assigning client or supplier", async () => {
    mock.requirePermission.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    expect((await POST(request({ vendorPartyId: "supplier" }))).status).toBe(403);
    expect(mock.requirePermission).toHaveBeenCalledWith(PERMISSIONS.partiesView);
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("creates a draft with workspace manage and the authorized owner", async () => {
    expect((await POST(request({ description: "quote" }))).status).toBe(201);
    expect(mock.agencyOwner).toHaveBeenCalledWith(PERMISSIONS.workspaceManage, expect.anything());
    expect(mock.create).toHaveBeenCalledWith(owner,{ description: "quote" });
  });
  it("submits without using finance authority or a posting shortcut", async () => {
    expect((await action(request({ action: "submit" }),context)).status).toBe(200);
    expect(mock.submit).toHaveBeenCalledWith(owner,"purchase");
    expect(mock.requirePermission).not.toHaveBeenCalled(); expect(mock.book).not.toHaveBeenCalled();
  });
  it("cannot book without finance.expenses_manage", async () => {
    mock.requirePermission.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    expect((await action(request({ action: "book", spentOn: "2026-10-06" }),context)).status).toBe(403);
    expect(mock.requirePermission).toHaveBeenCalledWith(PERMISSIONS.financeExpensesManage);
    expect(mock.book).not.toHaveBeenCalled();
  });
  it("book passes the supplied cost date and never approves a purchase", async () => {
    expect((await action(request({ action: "book", spentOn: "2026-10-06" }),context)).status).toBe(200);
    expect(mock.book).toHaveBeenCalledWith(owner,"purchase","2026-10-06");
    expect((await action(request({ action: "approve" }),context)).status).toBe(400);
  });
  it("maps source-state conflicts rather than reporting success", async () => {
    mock.book.mockRejectedValue(new VendorPurchaseError("invalid_purchase_state"));
    const res=await action(request({ action: "book" }),context);
    expect(res.status).toBe(409); expect(await res.json()).toEqual({ error:"invalid_purchase_state" });
  });
});
