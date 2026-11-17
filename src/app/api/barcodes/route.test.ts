import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { requireCapabilityForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem } from "@/lib/items-service";
import { assignBarcode, listBarcodes } from "@/lib/item-barcodes-service";
import { PERMISSIONS } from "@/lib/permissions";
const lockedQuery = vi.fn();
vi.mock("@/lib/db", () => ({ withTenantTransaction: async (_id: string, fn: (client: unknown) => unknown) => fn({ query: lockedQuery }) }));
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/industry-guard", () => ({ requireCapabilityForApi: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/items-service", () => ({ getItem: vi.fn() }));
vi.mock("@/lib/item-barcodes-service", () => ({ assignBarcode: vi.fn(), listBarcodes: vi.fn() }));
import { GET, POST } from "./route";
function request(expectedLocationId?: string) { return new NextRequest("http://localhost/api/barcodes", { method: "POST", body: JSON.stringify({ itemId: "item", code: "2000000000015", expectedLocationId }) }); }
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({ session: { businessId: "business" }, error: null } as never);
  vi.mocked(requireCapabilityForApi).mockResolvedValue(null);
  vi.mocked(resolveActiveLocation).mockResolvedValue({ id: "branch" } as never);
  lockedQuery.mockResolvedValue({ rows: [{ id: "item" }] });
  vi.mocked(getItem).mockResolvedValue({ id: "item", locationId: "branch" } as never);
  vi.mocked(assignBarcode).mockResolvedValue({ code: "2000000000015" } as never);
});
describe("native barcode assignment branch safety", () => {
  it("requires native inventory adjustment and barcode capability", async () => {
    vi.mocked(requirePermission).mockResolvedValueOnce({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
    expect((await POST(request("branch"))).status).toBe(403);
    vi.mocked(requireCapabilityForApi).mockResolvedValueOnce(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    expect((await POST(request("branch"))).status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryAdjust);
    expect(assignBarcode).not.toHaveBeenCalled();
  });
  it("refuses a stale active branch or another branch's item without writing", async () => {
    const changed = await POST(request("old"));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: "location_changed" });
    lockedQuery.mockResolvedValueOnce({ rows: [] });
    expect((await POST(request("branch"))).status).toBe(404);
    expect(assignBarcode).not.toHaveBeenCalled();
  });
  it("accepts a matching branch and preserves callers without the optional precondition", async () => {
    expect((await POST(request("branch"))).status).toBe(200);
    expect((await POST(request())).status).toBe(200);
    expect(assignBarcode).toHaveBeenCalledTimes(2);
  });
  it("takes a branch-scoped item lock before assigning the code", async () => {
    expect((await POST(request("branch"))).status).toBe(200);
    expect(lockedQuery).toHaveBeenCalledWith(expect.stringContaining("location_id = $2 FOR UPDATE"), ["item", "branch"]);
    expect(assignBarcode).toHaveBeenCalledWith("item", expect.objectContaining({ code: "2000000000015" }), expect.objectContaining({ query: lockedQuery }));
  });
  it("does not return codes left at a different branch", async () => {
    vi.mocked(listBarcodes).mockResolvedValue([{ id: "own", locationId: "branch" }, { id: "other", locationId: "other" }] as never);
    const result = await GET(new NextRequest("http://localhost/api/barcodes?itemId=item"));
    expect(await result.json()).toEqual({ barcodes: [{ id: "own", locationId: "branch" }] });
  });
});
