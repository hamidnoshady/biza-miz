import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PNG } from "pngjs";
import * as auth from "@/lib/auth";
import * as detail from "@/lib/integrations/woo-order-detail-service";
import * as loader from "@/lib/printing/document-loader";
import * as plans from "@/lib/printing/plan";
import * as chromium from "@/lib/printing/chromium";
import * as db from "@/lib/db";
import { builtInTemplate } from "@/lib/print-template";
import { jobHtml } from "@/lib/printing/render-service";
import { buildWooPrintDocument } from "@/lib/printing/woo-order-print-data";
import { BUSINESS, CONNECTION, LOCATION, PRINTER, REVISION, STAFF, wooDetail } from "@/lib/printing/__fixtures__/woo-order";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({ requirePermission: vi.fn(), withTenantScope: (fn: unknown) => fn }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn(async () => ({ id: LOCATION })) }));
vi.mock("@/lib/integrations/woo-order-detail-service", () => ({ wooConnectionForPrint: vi.fn() }));
vi.mock("@/lib/printing/document-loader", () => ({ loadPrintDocument: vi.fn() }));
vi.mock("@/lib/printing/plan", () => ({ resolvePrintPlan: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/printing/chromium", async original => ({ ...await original<typeof import("@/lib/printing/chromium")>(), renderHtmlToPng: vi.fn() }));

const document = { kind: "woo-order-invoice", connectionId: CONNECTION, remoteId: "1042", snapshotId: REVISION };
const template = builtInTemplate("woo-a4-invoice")!;
const plan = {
  locationId: LOCATION, documentType: "woo_invoice", template, templateId: null, templateKey: template.key, templateVersion: 1, templateSource: "builtin", paper: "a4", branding: {}, reason: "default", fallbackPrinter: null,
  printer: { id: PRINTER, name: "چاپگر فاکتور", kind: "document", is_active: true, paper: "a4", connection: { type: "windows", systemName: "Office" } },
} as plans.PrintPlan;
const job = { type: "woo-order" as const, data: buildWooPrintDocument(wooDetail(), "woo_invoice", "toman") };
const request = (body: unknown) => new NextRequest("https://tenant.example/api/printing/preview", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: BUSINESS, sub: STAFF, role: "owner" }, error: null } as never);
  vi.mocked(detail.wooConnectionForPrint).mockResolvedValue({ id: CONNECTION } as never);
  vi.mocked(loader.loadPrintDocument).mockResolvedValue({ ok: true, document: { job, entityId: `woo:${CONNECTION}:1042`, source: "woo-order-invoice" } });
  vi.mocked(plans.resolvePrintPlan).mockResolvedValue({ ok: true, plan });
  vi.mocked(chromium.renderHtmlToPng).mockResolvedValue(PNG.sync.write(new PNG({ width: 8, height: 8 })));
});

describe("first-party authorized Woo preview", () => {
  it("uses the identical source/plan/renderer as production and returns only a private raster, without jobs or handoff", async () => {
    const response = await POST(request({ document, templateKey: template.key, html: "CLIENT_HTML", total: "1", recipient: "FORGED" }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ ok: true, paper: { key: "a4", widthMm: 210, heightMm: 297 }, templateName: template.name, templateVersion: 1 });
    expect(Buffer.from(result.imageBase64, "base64").readUInt32BE(0)).toBe(0x89504e47);
    expect(chromium.renderHtmlToPng).toHaveBeenCalledWith(jobHtml(plan, job, job.data).html, expect.any(Number), { deviceScaleFactor: 2 });
    expect(String(vi.mocked(chromium.renderHtmlToPng).mock.calls[0][0])).not.toContain("CLIENT_HTML");
    expect(loader.loadPrintDocument).toHaveBeenCalledWith({ businessId: BUSINESS, locationId: LOCATION, document, documentType: "woo_invoice" });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(auth.requirePermission).toHaveBeenCalledWith("woocommerce.view");
    expect(auth.requirePermission).toHaveBeenCalledWith("printing.execute");
    expect(db.query).not.toHaveBeenCalled();
  });
  it.each(["printing.execute", "woocommerce.view"])("requires %s independently", async permission => {
    vi.mocked(auth.requirePermission).mockImplementation((async (p: string) => p === permission ? { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } : { session: { businessId: BUSINESS }, error: null }) as never);
    expect((await POST(request({ document }))).status).toBe(403);
    expect(loader.loadPrintDocument).not.toHaveBeenCalled();
    expect(chromium.renderHtmlToPng).not.toHaveBeenCalled();
  });
  it("denies foreign branch/tenant store ids before querying a document", async () => {
    vi.mocked(detail.wooConnectionForPrint).mockResolvedValue(null);
    expect((await POST(request({ document }))).status).toBe(404);
    expect(loader.loadPrintDocument).not.toHaveBeenCalled();
  });
  it.each([
    { document: { ...document, remoteId: "bogus" } },
    { job: { type: "document", html: "EVIL" } },
    { document, failedPrinterId: PRINTER },
    { document: { kind: "order-receipt", orderId: REVISION } },
  ])("rejects non-Woo or browser-authored/invalid preview input: %j", async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(chromium.renderHtmlToPng).not.toHaveBeenCalled();
  });
  it("enforces source lookup errors and document kind, rather than silently previewing a sample", async () => {
    expect((await POST(request({ document, documentType: "invoice" }))).status).toBe(409);
    vi.mocked(loader.loadPrintDocument).mockResolvedValue({ ok: false, status: 404, error: "document_not_found" });
    expect((await POST(request({ document }))).status).toBe(404);
    expect(chromium.renderHtmlToPng).not.toHaveBeenCalled();
  });
  it("caps requests", async () => {
    expect((await POST(request({ document, html: "x".repeat(17 * 1024) }))).status).toBe(413);
    expect(chromium.renderHtmlToPng).not.toHaveBeenCalled();
  });
});
