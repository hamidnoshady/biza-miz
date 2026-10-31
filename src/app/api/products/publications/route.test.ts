import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import { POST } from "./route";
const mocks = vi.hoisted(() => ({ permission: vi.fn(), accessible: vi.fn(), preview: vi.fn(), queue: vi.fn() }));
vi.mock("@/lib/auth", () => ({ withTenantScope: (fn: unknown) => fn, requirePermission: mocks.permission }));
vi.mock("@/lib/db", () => ({ withTenantTransaction: async (_businessId: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn(async () => ({ id: "branch" })) }));
vi.mock("@/lib/industry-guard", () => ({ requireProductWorkspaceForApi: vi.fn(async () => null) }));
vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: mocks.accessible, listAccessibleConnections: vi.fn() }));
vi.mock("@/lib/integrations/product-publication-service", () => ({ previewProductPublication: mocks.preview, publicationStores: vi.fn(), queueProductPublication: mocks.queue }));
const session = { sub: "member", businessId: "trusted-business" };
const storeId = "11111111-1111-4111-8111-111111111111";
const itemId = "22222222-2222-4222-8222-222222222222";
const request = (extra = {}) => new NextRequest("http://localhost/api/products/publications", { method: "POST", body: JSON.stringify({ localId: itemId, stores: [{ connectionId: storeId }], ...extra }) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission.mockResolvedValue({ session, error: null });
  mocks.accessible.mockResolvedValue({ id: storeId });
  mocks.preview.mockResolvedValue({ connectionId: storeId, reviewToken: "reviewed", payload: {} });
});
describe("Accounting publication authorization", () => {
  it.each([PERMISSIONS.inventoryAdjust, PERMISSIONS.integrationsManage])("requires %s before product or store access", async denied => {
    mocks.permission.mockImplementation(async permission => ({ session, error: permission === denied ? NextResponse.json({ error: "forbidden" }, { status: 403 }) : null }));
    expect((await POST(request())).status).toBe(403);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("refuses a store outside the member's accessible branches", async () => {
    mocks.accessible.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(404);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it("uses session tenancy and active branch, never supplied business or location IDs", async () => {
    expect((await POST(request({ businessId: "attacker", locationId: "other" }))).status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith("trusted-business", "branch", storeId, itemId, undefined);
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("rejects a stale review before enqueuing any store", async () => {
    expect((await POST(request({ confirm: true, stores: [{ connectionId: storeId, reviewToken: "stale" }] }))).status).toBe(409);
    expect(mocks.queue).not.toHaveBeenCalled();
  });
});
