/**
 * POST /api/printing/print — the one hardware print endpoint. These tests pin
 * the security model of the unified architecture:
 *
 *  - the request is an INTENT: a stored document to name (an order, an item),
 *    a document type and optional printer/template ids. Arbitrary rendered HTML
 *    is not a job type at all, and neither is a browser-built receipt — a
 *    `printingExecute` role can never make the server's Chromium render markup
 *    the product did not build, nor print money, items or a branch letterhead
 *    the database does not say;
 *  - the document is loaded server-side and scoped to the CALLER's active
 *    location, so another branch's sale is simply not found (and printer/
 *    template ids from another branch do not resolve either);
 *  - a hardware address in the body is ignored — the plan's saved printer
 *    decides the target;
 *  - a plan refusal maps to its canonical status (404 unknown row, 409
 *    unusable/unconfigured) and never to a render;
 *  - every attempt writes its own history row, and the row is the id the
 *    browser closes the delivery with;
 *  - success returns the bytes, the resolved target and the provenance
 *    (template id/key/version, route, fallback) the job row records.
 *
 * The plan resolver, the render service and the document loader are mocked;
 * their behaviour is pinned in src/lib/printing/{plan,render-service,
 * document-loader}.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as setupState from "@/lib/setup-state";
import * as planModule from "@/lib/printing/plan";
import * as renderService from "@/lib/printing/render-service";
import * as loader from "@/lib/printing/document-loader";
import { POST } from "./route";
import type { PrintPlan } from "@/lib/printing/plan";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/printing/plan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/printing/plan")>();
  return { ...actual, resolvePrintPlan: vi.fn() };
});

vi.mock("@/lib/printing/render-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/printing/render-service")>();
  return { ...actual, preparePrint: vi.fn() };
});

vi.mock("@/lib/printing/document-loader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/printing/document-loader")>();
  return { ...actual, loadPrintDocument: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "cashier" };

/** Real-shaped ids: the endpoint validates them, so a fake like "order-1" is not a valid test input. */
const ORDER_ID = "1f3d5b70-2c94-4a1e-8f6d-0b2c4e6a8d10";
const ITEM_ID = "2a4e6c81-3d05-4b2f-9a7e-1c3d5f7b9e21";
const PRINTER_ID = "3b5f7d92-4e16-4c30-8b8f-2d4e6a8c0f32";
const TEMPLATE_ID = "4c608e03-5f27-4d41-9c90-3e5f7b9d1a43";
const JOB_ID = "5d719f14-6a38-4e52-8da1-4f608c0e2b54";
const BARCODE = "2000000000015";

function plan(overrides: Partial<PrintPlan> = {}): PrintPlan {
  const printer = {
    id: PRINTER_ID,
    name: "چاپگر صندوق",
    kind: "receipt" as const,
    connection: { type: "windows" as const, systemName: "EPSON TM-T20III" },
    is_active: true,
    printer_class: "thermal" as const,
    paper: "thermal80" as const,
    paper_width_mm: 80,
    supports_drawer: true,
    supports_cut: true,
  };
  return {
    locationId: "loc-1",
    documentType: "receipt",
    printer,
    fallbackPrinter: null,
    routingPrinter: {
      id: printer.id,
      name: printer.name,
      purpose: "receipt",
      printerClass: "thermal",
      isActive: true,
      isDefault: true,
      needsReconnect: false,
      supportsDrawer: true,
      paper: "thermal80",
    },
    template: {
      key: "saved-1",
      name: "قالب من",
      docType: "receipt",
      paper: "thermal80",
      options: { fontScale: 1, lineHeight: 1.5, marginMm: 3, bodyWeight: 500, showUnit: true, copies: 1 },
      blocks: [{ id: "b", type: "businessName", visible: true }],
    },
    templateId: TEMPLATE_ID,
    templateKey: "saved-1",
    templateVersion: 12,
    templateSource: "rule",
    paper: "thermal80",
    branding: {},
    reason: "rule",
    ...overrides,
  };
}

function request(body: unknown, method = "POST"): NextRequest {
  return {
    json: async () => body,
    method,
    headers: { get: () => null },
  } as unknown as NextRequest;
}

// Every successful render logs its provenance (that log is a feature — it is
// how support correlates a paper receipt with a template revision). Tests do
// not need it on stdout.
let infoSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterAll(() => {
  infoSpy.mockRestore();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({ ok: true, plan: plan() } as never);
  vi.mocked(renderService.preparePrint).mockResolvedValue({
    delivery: "raw",
    bytes: Buffer.from([0x1b, 0x40, 0x1d, 0x56]),
  } as never);
  vi.mocked(loader.loadPrintDocument).mockResolvedValue({
    ok: true,
    document: {
      job: { type: "receipt", receipt: { business: { name: "کافه" } } } as never,
      entityId: ORDER_ID,
      source: "order-receipt",
    },
  } as never);
  vi.mocked(db.query).mockImplementation((async (sql: string) =>
    String(sql).includes("INSERT INTO print_jobs") ? { rows: [{ id: JOB_ID }], rowCount: 1 } : { rows: [], rowCount: 0 }) as never);
});

describe("guards", () => {
  it("lets every print-triggering role through the gate", async () => {
    await POST(request({ job: { type: "test", kind: "receipt" } }));
    expect(auth.requirePermission).toHaveBeenCalledWith("printing.execute");
  });

  it("returns the role gate's error untouched", async () => {
    const denied = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await POST(request({ job: { type: "test", kind: "receipt" } }));
    expect(response.status).toBe(401);
    expect(planModule.resolvePrintPlan).not.toHaveBeenCalled();
    expect(renderService.preparePrint).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body and an unknown job type with 400", async () => {
    const bad = { json: async () => Promise.reject(new Error("boom")), headers: { get: () => null } } as unknown as NextRequest;
    expect((await POST(bad)).status).toBe(400);
    expect((await POST(request({ job: { type: "fax" } }))).status).toBe(400);
    expect(planModule.resolvePrintPlan).not.toHaveBeenCalled();
  });

  it("requires a payload — either a document to load or one of the two sample jobs", async () => {
    for (const body of [{}, { job: {} }, { job: { type: "test" } }, { document: {} }, { document: { kind: "order-receipt" } }]) {
      const response = await POST(request(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(planModule.resolvePrintPlan).not.toHaveBeenCalled();
  });

  it("rejects a body that asks for both a document and a job", async () => {
    const response = await POST(
      request({ document: { kind: "order-receipt", orderId: ORDER_ID }, job: { type: "test", kind: "receipt" } }),
    );
    expect(response.status).toBe(400);
  });

  it("refuses a body larger than an intent could ever need", async () => {
    const huge = { json: async () => ({ document: { kind: "order-receipt", orderId: ORDER_ID } }), headers: { get: () => "200000" } };
    expect((await POST(huge as unknown as NextRequest)).status).toBe(413);
    expect(planModule.resolvePrintPlan).not.toHaveBeenCalled();
  });
});

describe("intent only — no client HTML, no client hardware, no client document", () => {
  it("has no document/html job type: rendered markup from a browser is simply not accepted", async () => {
    const response = await POST(
      request({ job: { type: "document", html: "<html><body>خارجی</body></html>", paper: "a4" } }),
    );
    expect(response.status).toBe(400);
    expect(renderService.preparePrint).not.toHaveBeenCalled();
  });

  it("refuses a browser-built receipt, ticket or label with document_required", async () => {
    for (const job of [
      { type: "receipt", receipt: { business: { name: "کافه" }, total: 1 } },
      { type: "kitchen-ticket", ticket: { label: "میز ۳", lines: [] } },
      { type: "label", label: { itemName: "کالا", code: BARCODE, fields: [] } },
    ]) {
      const response = await POST(request({ job }));
      expect(response.status, JSON.stringify(job)).toBe(400);
      expect(await response.json()).toMatchObject({ error: "document_required" });
    }
    expect(planModule.resolvePrintPlan).not.toHaveBeenCalled();
    expect(renderService.preparePrint).not.toHaveBeenCalled();
  });

  it("refuses ids that are not ids, before any query", async () => {
    for (const body of [
      { document: { kind: "order-receipt", orderId: "order-1" } },
      { document: { kind: "kitchen-ticket", orderId: "'; DROP TABLE orders; --" } },
      { document: { kind: "item-label", itemId: "item-1" } },
      { document: { kind: "nonsense", orderId: ORDER_ID } },
      { document: { kind: "item-label", itemId: ITEM_ID, code: "not a barcode!" } },
      { document: { kind: "order-receipt", orderId: ORDER_ID }, documentType: "poster" },
      { document: { kind: "order-receipt", orderId: ORDER_ID }, printerId: "printer-1" },
      { document: { kind: "order-receipt", orderId: ORDER_ID }, templateId: "saved-1" },
      { document: { kind: "order-receipt", orderId: ORDER_ID }, printRequestId: "x".repeat(200) },
    ]) {
      const response = await POST(request(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(loader.loadPrintDocument).not.toHaveBeenCalled();
    expect(planModule.resolvePrintPlan).not.toHaveBeenCalled();
  });

  it("ignores an arbitrary connection object in the body — the saved row decides the target", async () => {
    const response = await POST(
      request({
        job: { type: "test", kind: "receipt" },
        connection: { type: "network", ip: "203.0.113.7", port: 9100 },
        target: { type: "network", ip: "198.51.100.9" },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { target: unknown };
    expect(body.target).toEqual({ type: "windows", systemName: "EPSON TM-T20III" });
  });

  it("routes a drawer kick to the receipt plan without being told to", async () => {
    const response = await POST(request({ printerId: PRINTER_ID, job: { type: "drawer-kick" } }));
    expect(response.status).toBe(200);
    expect(planModule.resolvePrintPlan).toHaveBeenCalledWith({
      locationId: "loc-1",
      documentType: "receipt",
      requestedPrinterId: PRINTER_ID,
      requestedTemplateId: null,
    });
    // A drawer kick carries no document, so nothing is loaded for it.
    expect(loader.loadPrintDocument).not.toHaveBeenCalled();
  });

  it("passes only the ids and the document type to the resolver — never a target", async () => {
    await POST(
      request({
        printerId: PRINTER_ID,
        templateId: TEMPLATE_ID,
        documentType: "receipt",
        document: { kind: "order-receipt", orderId: ORDER_ID },
      }),
    );
    expect(planModule.resolvePrintPlan).toHaveBeenCalledWith({
      locationId: "loc-1",
      documentType: "receipt",
      requestedPrinterId: PRINTER_ID,
      requestedTemplateId: TEMPLATE_ID,
    });
  });
});

describe("the document is loaded server-side, for this branch only", () => {
  it("loads the named sale for the caller's active branch and records its id", async () => {
    await POST(request({ printRequestId: "receipt:1", document: { kind: "order-receipt", orderId: ORDER_ID } }));
    expect(loader.loadPrintDocument).toHaveBeenCalledWith({
      businessId: "biz-1",
      locationId: "loc-1",
      document: { kind: "order-receipt", orderId: ORDER_ID },
      documentType: "receipt",
    });
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toContain("INSERT INTO print_jobs");
    // The entity id is the server's own resolution of the document, not a
    // field the caller supplied.
    expect(params[2]).toBe(ORDER_ID);
  });

  it("prints a sale as its formal invoice when the caller names that document type", async () => {
    await POST(request({ documentType: "invoice", document: { kind: "order-receipt", orderId: ORDER_ID } }));
    expect(planModule.resolvePrintPlan).toHaveBeenCalledWith(
      expect.objectContaining({ documentType: "invoice" }),
    );
    expect(loader.loadPrintDocument).toHaveBeenCalledWith(expect.objectContaining({ documentType: "invoice" }));
  });

  it("defaults each document kind to its own document type", async () => {
    await POST(request({ document: { kind: "kitchen-ticket", orderId: ORDER_ID } }));
    expect(planModule.resolvePrintPlan).toHaveBeenCalledWith(expect.objectContaining({ documentType: "kitchen" }));
    vi.clearAllMocks();
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
    vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({ ok: true, plan: plan({ documentType: "label" }) } as never);
    vi.mocked(loader.loadPrintDocument).mockResolvedValue({ ok: true, document: { job: { type: "label" } as never, entityId: "bc-1", source: "item-label" } } as never);
    vi.mocked(db.query).mockResolvedValue({ rows: [{ id: JOB_ID }], rowCount: 1 } as never);
    await POST(request({ document: { kind: "item-label", itemId: ITEM_ID, code: BARCODE } }));
    expect(planModule.resolvePrintPlan).toHaveBeenCalledWith(expect.objectContaining({ documentType: "label" }));
    expect(loader.loadPrintDocument).toHaveBeenCalledWith(
      expect.objectContaining({ document: { kind: "item-label", itemId: ITEM_ID, code: BARCODE } }),
    );
  });

  it("refuses a document printed as the wrong kind of document, before resolving anything", async () => {
    const kitchen = await POST(
      request({ documentType: "receipt", document: { kind: "kitchen-ticket", orderId: ORDER_ID } }),
    );
    expect(kitchen.status).toBe(409);
    expect(await kitchen.json()).toMatchObject({ error: "document_type_mismatch" });

    const label = await POST(
      request({ documentType: "invoice", document: { kind: "item-label", itemId: ITEM_ID } }),
    );
    expect(label.status).toBe(409);
    expect(planModule.resolvePrintPlan).not.toHaveBeenCalled();
    expect(renderService.preparePrint).not.toHaveBeenCalled();
  });

  it("answers a document of another branch (or none at all) with 404 document_not_found", async () => {
    vi.mocked(loader.loadPrintDocument).mockResolvedValue({
      ok: false,
      status: 404,
      error: "document_not_found",
    } as never);
    const response = await POST(request({ document: { kind: "order-receipt", orderId: ORDER_ID } }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "document_not_found" });
    expect(renderService.preparePrint).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("plan refusals", () => {
  it("maps an unknown printer or template to 404 with its own code", async () => {
    vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({ ok: false, error: "printer_not_found" } as never);
    const printer = await POST(request({ printerId: PRINTER_ID, job: { type: "test", kind: "receipt" } }));
    expect(printer.status).toBe(404);
    expect(await printer.json()).toMatchObject({ error: "printer_not_found" });

    vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({ ok: false, error: "template_not_found" } as never);
    const template = await POST(request({ templateId: TEMPLATE_ID, job: { type: "test", kind: "receipt" } }));
    expect(template.status).toBe(404);
    expect(await template.json()).toMatchObject({ error: "template_not_found" });
  });

  it("maps an unconfigured or unusable printer to 409", async () => {
    for (const error of ["printer_not_configured", "printer_unavailable", "incompatible_printer", "template_invalid"] as const) {
      vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({ ok: false, error } as never);
      const response = await POST(request({ document: { kind: "order-receipt", orderId: ORDER_ID } }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error });
    }
    expect(renderService.preparePrint).not.toHaveBeenCalled();
  });

  it("refuses an inactive printer and a reconnect-required legacy row before loading anything", async () => {
    vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({
      ok: true,
      plan: plan({ printer: { ...plan().printer, is_active: false } }),
    } as never);
    const inactive = await POST(request({ printerId: PRINTER_ID, document: { kind: "order-receipt", orderId: ORDER_ID } }));
    expect(inactive.status).toBe(409);
    expect(await inactive.json()).toMatchObject({ error: "printer_inactive" });

    vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({
      ok: true,
      plan: plan({ printer: { ...plan().printer, connection: { needsReconnect: true, legacyTransport: "webusb" } } }),
    } as never);
    const legacy = await POST(request({ printerId: PRINTER_ID, document: { kind: "order-receipt", orderId: ORDER_ID } }));
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toMatchObject({ error: "reconnect_required" });
    expect(loader.loadPrintDocument).not.toHaveBeenCalled();
    expect(renderService.preparePrint).not.toHaveBeenCalled();
  });

  it("refuses a printer whose connection names no usable target", async () => {
    vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({
      ok: true,
      plan: plan({ printer: { ...plan().printer, connection: { type: "windows", systemName: "  " } } }),
    } as never);
    const response = await POST(request({ printerId: PRINTER_ID, document: { kind: "order-receipt", orderId: ORDER_ID } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "invalid_printer" });
  });
});

describe("render, history and provenance", () => {
  it("returns the rendered bytes, the target and the template revision that produced them", async () => {
    const bytes = Buffer.from([0x1b, 0x40, 0x00, 0x01]);
    vi.mocked(renderService.preparePrint).mockResolvedValue({ delivery: "raw", bytes } as never);
    const response = await POST(
      request({
        printerId: PRINTER_ID,
        printRequestId: "req-1",
        document: { kind: "order-receipt", orderId: ORDER_ID },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      delivery: "raw",
      target: { type: "windows", systemName: "EPSON TM-T20III" },
      printerId: PRINTER_ID,
      printerName: "چاپگر صندوق",
      supportsDrawer: true,
      templateId: TEMPLATE_ID,
      templateKey: "saved-1",
      templateVersion: 12,
      templateSource: "rule",
      route: "rule",
      jobId: JOB_ID,
      printRequestId: "req-1",
      entityId: ORDER_ID,
    });
    expect(body.dataBase64).toBe(bytes.toString("base64"));
  });

  it("opens a history row for every attempt, with the printer, template revision and document", async () => {
    await POST(
      request({ printerId: PRINTER_ID, printRequestId: "req-2", document: { kind: "order-receipt", orderId: ORDER_ID } }),
    );
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toContain("INSERT INTO print_jobs");
    expect(String(sql)).toContain("template_version");
    expect(String(sql)).toContain("RETURNING id");
    // No uniqueness key: two prints of one document are two attempts.
    expect(String(sql)).not.toContain("ON CONFLICT");
    expect(params).toEqual(["loc-1", "receipt", ORDER_ID, PRINTER_ID, TEMPLATE_ID, "saved-1", 12, "req-2"]);
  });

  it("records an attempt even when the caller supplies no request id at all", async () => {
    const response = await POST(request({ job: { type: "test", kind: "receipt" } }));
    expect(response.status).toBe(200);
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toContain("INSERT INTO print_jobs");
    expect(params[7]).toBeNull();
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ jobId: JOB_ID, printRequestId: null });
  });

  it("closes the attempt itself when the render fails, and still answers 502", async () => {
    vi.mocked(renderService.preparePrint).mockRejectedValue(new Error("chromium gone") as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(request({ printerId: PRINTER_ID, document: { kind: "order-receipt", orderId: ORDER_ID } }));
    errorSpy.mockRestore();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "render_failed", jobId: JOB_ID });
    const [sql, params] = vi.mocked(db.query).mock.calls[1] as [string, unknown[]];
    expect(String(sql)).toContain("SET status = 'failed'");
    expect(String(sql)).toContain("status = 'sending'");
    expect(params).toEqual([JOB_ID, "render_failed"]);
  });

  it("keeps history best-effort: a failed insert still returns the bytes", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(db.query).mockRejectedValue(new Error("history down") as never);
    const response = await POST(request({ printerId: PRINTER_ID, printRequestId: "req-3", job: { type: "test", kind: "receipt" } }));
    errorSpy.mockRestore();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, jobId: null });
  });

  it("reports which printer the fallback replaced", async () => {
    vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({
      ok: true,
      plan: plan({
        reason: "fallback",
        fallbackPrinter: { ...plan().printer, id: "aaaa1111-2222-4333-8444-555566667777", name: "اصلی" },
      }),
    } as never);
    const response = await POST(request({ job: { type: "test", kind: "receipt" } }));
    expect(await response.json()).toMatchObject({
      route: "fallback",
      fallbackFromPrinterId: "aaaa1111-2222-4333-8444-555566667777",
    });
  });
});
