import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem, updateItemMeta } from "@/lib/items-service";
import { PERMISSIONS } from "@/lib/permissions";
import { PATCH } from "./route";

vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/industry-guard", () => ({ requireProductWorkspaceForApi: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/items-service", () => ({ getItem: vi.fn(), updateItemMeta: vi.fn() }));

const session = { businessId: "business" };
const context = { params: Promise.resolve({ id: "item" }) };
const request = () => new NextRequest("http://localhost/api/products/items/item/meta", { method: "PATCH", body: JSON.stringify({ name: "کالا" }) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(resolveActiveLocation).mockResolvedValue({ id: "branch" } as never);
  vi.mocked(getItem).mockResolvedValue({ locationId: "branch" } as never);
  vi.mocked(updateItemMeta).mockResolvedValue({ id: "item" } as never);
});

describe("product metadata mutation permissions", () => {
  it("requires both menu.edit and inventory.adjust before writing", async () => {
    expect((await PATCH(request(), context)).status).toBe(200);
    expect(vi.mocked(requirePermission).mock.calls.map(([permission]) => permission)).toEqual([PERMISSIONS.menuEdit, PERMISSIONS.inventoryAdjust]);
    expect(updateItemMeta).toHaveBeenCalledOnce();
  });
  it("rejects a specialist industry or a product in another branch", async () => {
    vi.mocked(requireProductWorkspaceForApi).mockResolvedValueOnce(NextResponse.json({ error: "industry_mismatch" }, { status: 403 }));
    expect((await PATCH(request(), context)).status).toBe(403);
    expect(getItem).not.toHaveBeenCalled();
    vi.mocked(getItem).mockResolvedValueOnce({ locationId: "other-branch" } as never);
    expect((await PATCH(request(), context)).status).toBe(404);
    expect(updateItemMeta).not.toHaveBeenCalled();
  });
  it.each([PERMISSIONS.menuEdit, PERMISSIONS.inventoryAdjust])("refuses a missing %s permission before reading or writing", async (denied) => {
    vi.mocked(requirePermission).mockImplementation(async (permission) => permission === denied
      ? { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never
      : { session, error: null } as never);
    expect((await PATCH(request(), context)).status).toBe(403);
    expect(getItem).not.toHaveBeenCalled();
    expect(updateItemMeta).not.toHaveBeenCalled();
  });
});
