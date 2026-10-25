import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as templates from "@/lib/print-templates-service";
import * as setupState from "@/lib/setup-state";
import * as templateContext from "@/lib/printing/template-catalog-server";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
}));
vi.mock("@/lib/print-templates-service", () => ({
  createPrintTemplate: vi.fn(),
  listPrintTemplates: vi.fn(),
}));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/printing/template-catalog-server", () => ({ loadTemplateAccessContext: vi.fn() }));

const SESSION = { businessId: "biz-1", sub: "owner-1" };
const receipt = {
  id: "saved-receipt",
  key: "saved-receipt",
  name: "فیش شعبه",
  docType: "receipt",
  paper: "thermal80",
  options: { fontScale: 1, lineHeight: 1.5, marginMm: 3, bodyWeight: 500, showUnit: true, copies: 1 },
  blocks: [{ id: "business", type: "businessName", visible: true }],
  isDefault: false,
  version: 1,
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const jewelryInvoice = {
  ...receipt,
  id: "saved-jewelry-invoice",
  key: "saved-jewelry-invoice",
  name: "فاکتور طلای شعبه",
  docType: "invoice",
  paper: "a4",
  sourceKey: "a4-invoice-jewelry",
};
const kitchen = {
  ...receipt,
  id: "saved-kitchen",
  key: "saved-kitchen",
  name: "سفارش آشپزخانهٔ شعبه",
  docType: "kitchen",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(templateContext.loadTemplateAccessContext).mockResolvedValue({ industry: "food_service", wooEnabled: false });
  vi.mocked(templates.listPrintTemplates).mockResolvedValue([receipt, jewelryInvoice, kitchen] as never);
  vi.mocked(templates.createPrintTemplate).mockResolvedValue({ error: "template_not_available" } as never);
});

describe("GET /api/settings/print-templates — eligible catalog", () => {
  it("returns only templates allowed for the active industry and explains retained ineligible saves", async () => {
    const response = await GET(new NextRequest("https://tenant.example/api/settings/print-templates"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.industry).toBe("food_service");
    expect(body.templates.map((template: { id: string }) => template.id)).toEqual(["saved-receipt", "saved-kitchen"]);
    expect(body.unavailableTemplates).toEqual([
      expect.objectContaining({ id: "saved-jewelry-invoice", reason: "industry_mismatch" }),
    ]);
    const builtInKeys = body.builtIns.map((template: { key: string }) => template.key);
    expect(builtInKeys).toContain("thermal80-kitchen");
    expect(builtInKeys).not.toContain("a4-invoice-jewelry");
    expect(builtInKeys).not.toContain("label57x40-label");
    expect(builtInKeys).not.toContain("woo-a4-invoice");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("fails closed when the branch business type cannot be resolved", async () => {
    vi.mocked(templateContext.loadTemplateAccessContext).mockResolvedValue(null);
    const response = await GET(new NextRequest("https://tenant.example/api/settings/print-templates"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "business_type_unavailable" });
  });
});

describe("POST /api/settings/print-templates — write policy", () => {
  it("passes server-resolved tenant policy to the write service, never a client-supplied policy", async () => {
    const request = new NextRequest("https://tenant.example/api/settings/print-templates", {
      method: "POST",
      body: JSON.stringify({ template: { ...jewelryInvoice, sourceKey: "a4-invoice-jewelry" }, industry: "food_service" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(403);
    expect(templates.createPrintTemplate).toHaveBeenCalledWith(expect.objectContaining({
      locationId: "loc-1",
      accessContext: { industry: "food_service", wooEnabled: false },
    }));
  });
});
