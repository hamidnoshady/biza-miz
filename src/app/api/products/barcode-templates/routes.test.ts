import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createWeightBarcodeTemplate, deleteWeightBarcodeTemplate, listWeightBarcodeTemplates } from "@/lib/weight-barcode-templates-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET, POST } from "./route";
import { DELETE } from "./[id]/route";

vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/industry-guard", () => ({ requireProductWorkspaceForApi: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/weight-barcode-templates-service", () => ({ createWeightBarcodeTemplate: vi.fn(), deleteWeightBarcodeTemplate: vi.fn(), listWeightBarcodeTemplates: vi.fn() }));

const session = { businessId: "business" };
const makeRequest = (method: string) => new NextRequest("http://localhost/api/products/barcode-templates", { method, ...(method === "POST" ? { body: JSON.stringify({ prefix: "20", weightUnit: "grams" }) } : {}) });
const context = { params: Promise.resolve({ id: "template" }) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(resolveActiveLocation).mockResolvedValue({ id: "branch" } as never);
  vi.mocked(listWeightBarcodeTemplates).mockResolvedValue([]);
  vi.mocked(createWeightBarcodeTemplate).mockResolvedValue({ template: {} as never });
  vi.mocked(deleteWeightBarcodeTemplate).mockResolvedValue(true);
});

describe("weight template route permissions and location", () => {
  it("requires both menu and inventory read permissions", async () => {
    expect((await GET()).status).toBe(200);
    expect(vi.mocked(requirePermission).mock.calls.map(([permission]) => permission)).toEqual([PERMISSIONS.menuView, PERMISSIONS.inventoryView]);
    expect(listWeightBarcodeTemplates).toHaveBeenCalledWith("branch");
  });
  it.each([PERMISSIONS.menuEdit, PERMISSIONS.inventoryAdjust])("refuses creation and deletion without %s", async (denied) => {
    vi.mocked(requirePermission).mockImplementation(async (permission) => permission === denied
      ? { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never
      : { session, error: null } as never);
    expect((await POST(makeRequest("POST"))).status).toBe(403);
    expect((await DELETE(makeRequest("DELETE"), context)).status).toBe(403);
    expect(createWeightBarcodeTemplate).not.toHaveBeenCalled();
    expect(deleteWeightBarcodeTemplate).not.toHaveBeenCalled();
  });
  it("deletes only from the resolved branch and reports an absent template", async () => {
    vi.mocked(deleteWeightBarcodeTemplate).mockResolvedValue(false);
    expect((await DELETE(makeRequest("DELETE"), context)).status).toBe(404);
    expect(deleteWeightBarcodeTemplate).toHaveBeenCalledWith("template", "branch");
  });
  it("does not touch data for a disallowed industry or absent branch", async () => {
    vi.mocked(requireProductWorkspaceForApi).mockResolvedValueOnce(NextResponse.json({ error: "industry_mismatch" }, { status: 403 }));
    expect((await POST(makeRequest("POST"))).status).toBe(403);
    vi.mocked(resolveActiveLocation).mockResolvedValueOnce(null);
    expect((await DELETE(makeRequest("DELETE"), context)).status).toBe(409);
    expect(createWeightBarcodeTemplate).not.toHaveBeenCalled();
    expect(deleteWeightBarcodeTemplate).not.toHaveBeenCalled();
  });
});
