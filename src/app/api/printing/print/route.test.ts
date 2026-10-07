/**
 * POST /api/printing/print — the one hardware print endpoint. These tests pin
 * the security model of the unified architecture:
 *
 *  - the request is an INTENT: a document type, a job's own data and optional
 *    printer/template ids. Arbitrary rendered HTML is not a job type at all,
 *    so a `printingExecute` role can never make the server's Chromium render
 *    markup the product did not build;
 *  - a hardware address in the body is ignored — the plan's saved printer
 *    decides the target — and printer/template ids are resolved against the
 *    CALLER's active location, so another branch's row simply does not exist;
 *  - a plan refusal maps to its canonical status (404 unknown row, 409
 *    unusable/unconfigured) and never to a render;
 *  - success returns the bytes, the resolved target and the provenance
 *    (template id/key/version, route, fallback) the job row records.
 *
 * The plan resolver and the render service are mocked; their behaviour is
 * pinned in src/lib/printing/plan.test.ts and render-service.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as setupState from "@/lib/setup-state";
import * as planModule from "@/lib/printing/plan";
import * as renderService from "@/lib/printing/render-service";
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

const SESSION = { businessId: "biz-1", sub: "user-1", role: "cashier" };

function plan(overrides: Partial<PrintPlan> = {}): PrintPlan {
  const printer = {
    id: "printer-1",
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
    templateId: "saved-1",
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
  return { json: async () => body, method } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({ ok: true, plan: plan() } as never);
  vi.mocked(renderService.preparePrint).mockResolvedValue({
    delivery: "raw",
    bytes: Buffer.from([0x1b, 0x40, 0x1d, 0x56]),
  } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [], rowCount: 1 } as never);
});

describe("guards", () => {
  it("lets every print-triggering role through the gate", async () => {
    await POST(request({ printerId: "printer-1", job: { type: "test", kind: "receipt" } }));
    expect(auth.requirePermission).toHaveBeenCalledWith("printing.execute");
  });

  it("returns the role gate's error untouched", async () => {
    const denied = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await POST(request({ printerId: "printer-1", job: { type: "test", kind: "receipt" } }));
    expect(response.status).toBe(401);
    expect(planModule.resolvePrintPlan).not.toHaveBeenCalled();
    expect(renderService.preparePrint).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body and an unknown job type with 400", async () => {
    const bad = { json: async () => Promise.reject(new Error("boom")) } as unknown as NextRequest;
    expect((await POST(bad)).status).toBe(400);
    expect((await POST(request({ printerId: "printer-1", job: { type: "fax" } }))).status).toBe(400);
    expect(planModule.resolvePrintPlan).not.toHaveBeenCalled();
  });

  it("requires the payload field each data job names", async () => {
    for (const job of [{ type: "receipt" }, { type: "kitchen-ticket" }, { type: "label" }, { type: "test" }, {}]) {
      const response = await POST(request({ printerId: "printer-1", job }));
      expect(response.status).toBe(400);
    }
    expect(planModule.resolvePrintPlan).not.toHaveBeenCalled();
  });
});

describe("intent only — no client HTML, no client hardware", () => {
  it("has no document/html job type: rendered markup from a browser is simply not accepted", async () => {
    const response = await POST(
      request({ printerId: "printer-1", job: { type: "document", html: "<html><body>خارجی</body></html>", paper: "a4" } }),
    );
    expect(response.status).toBe(400);
    expect(renderService.preparePrint).not.toHaveBeenCalled();
  });

  it("ignores an arbitrary connection object in the body — the saved row decides the target", async () => {
    const response = await POST(
      request({
        printerId: "printer-1",
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
    const response = await POST(request({ printerId: "printer-1", job: { type: "drawer-kick" } }));
    expect(response.status).toBe(200);
    expect(planModule.resolvePrintPlan).toHaveBeenCalledWith({
      locationId: "loc-1",
      documentType: "receipt",
      requestedPrinterId: "printer-1",
      requestedTemplateId: null,
    });
  });

  it("passes only the ids and the document type to the resolver — never a target", async () => {
    await POST(
      request({ printerId: "printer-1", templateId: "saved-1", documentType: "receipt", job: { type: "receipt", receipt: { business: { name: "کافه" } } } }),
    );
    expect(planModule.resolvePrintPlan).toHaveBeenCalledWith({
      locationId: "loc-1",
      documentType: "receipt",
      requestedPrinterId: "printer-1",
      requestedTemplateId: "saved-1",
    });
  });
});

describe("plan refusals", () => {
  it("maps an unknown printer or template to 404 with its own code", async () => {
    vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({ ok: false, error: "printer_not_found" } as never);
    const printer = await POST(request({ printerId: "another-branch-printer", job: { type: "test", kind: "receipt" } }));
    expect(printer.status).toBe(404);
    expect(await printer.json()).toMatchObject({ error: "printer_not_found" });

    vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({ ok: false, error: "template_not_found" } as never);
    const template = await POST(request({ templateId: "gone", job: { type: "test", kind: "receipt" } }));
    expect(template.status).toBe(404);
    expect(await template.json()).toMatchObject({ error: "template_not_found" });
  });

  it("maps an unconfigured or unusable printer to 409", async () => {
    for (const error of ["printer_not_configured", "printer_unavailable", "incompatible_printer", "template_invalid"] as const) {
      vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({ ok: false, error } as never);
      const response = await POST(request({ job: { type: "receipt", receipt: { business: { name: "کافه" } } } }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error });
    }
    expect(renderService.preparePrint).not.toHaveBeenCalled();
  });

  it("refuses an inactive printer and a reconnect-required legacy row before rendering", async () => {
    vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({
      ok: true,
      plan: plan({ printer: { ...plan().printer, is_active: false } }),
    } as never);
    const inactive = await POST(request({ printerId: "printer-1", job: { type: "test", kind: "receipt" } }));
    expect(inactive.status).toBe(409);
    expect(await inactive.json()).toMatchObject({ error: "printer_inactive" });

    vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({
      ok: true,
      plan: plan({ printer: { ...plan().printer, connection: { needsReconnect: true, legacyTransport: "webusb" } } }),
    } as never);
    const legacy = await POST(request({ printerId: "printer-1", job: { type: "test", kind: "receipt" } }));
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toMatchObject({ error: "reconnect_required" });
    expect(renderService.preparePrint).not.toHaveBeenCalled();
  });

  it("refuses a printer whose connection names no usable target", async () => {
    vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({
      ok: true,
      plan: plan({ printer: { ...plan().printer, connection: { type: "windows", systemName: "  " } } }),
    } as never);
    const response = await POST(request({ printerId: "printer-1", job: { type: "test", kind: "receipt" } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "invalid_printer" });
  });
});

describe("render and provenance", () => {
  it("returns the rendered bytes, the target and the template revision that produced them", async () => {
    const bytes = Buffer.from([0x1b, 0x40, 0x00, 0x01]);
    vi.mocked(renderService.preparePrint).mockResolvedValue({ delivery: "raw", bytes } as never);
    const response = await POST(
      request({
        printerId: "printer-1",
        printRequestId: "req-1",
        entityId: "order-1",
        job: { type: "receipt", receipt: { business: { name: "کافه" } } },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      delivery: "raw",
      target: { type: "windows", systemName: "EPSON TM-T20III" },
      printerId: "printer-1",
      printerName: "چاپگر صندوق",
      supportsDrawer: true,
      templateId: "saved-1",
      templateKey: "saved-1",
      templateVersion: 12,
      templateSource: "rule",
      route: "rule",
    });
    expect(body.dataBase64).toBe(bytes.toString("base64"));
  });

  it("records the printer, template id/key/version and document type on the job row", async () => {
    await POST(
      request({
        printerId: "printer-1",
        printRequestId: "req-2",
        entityId: "order-9",
        job: { type: "receipt", receipt: { business: { name: "کافه" } } },
      }),
    );
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toContain("INSERT INTO print_jobs");
    expect(String(sql)).toContain("template_version");
    expect(params).toEqual(["loc-1", "receipt", "order-9", "printer-1", "saved-1", "saved-1", 12, "req-2"]);
  });

  it("keeps history best-effort: a failed insert still returns the bytes", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(db.query).mockRejectedValue(new Error("history down") as never);
    const response = await POST(request({ printerId: "printer-1", printRequestId: "req-3", job: { type: "test", kind: "receipt" } }));
    errorSpy.mockRestore();
    expect(response.status).toBe(200);
  });

  it("reports which printer the fallback replaced", async () => {
    vi.mocked(planModule.resolvePrintPlan).mockResolvedValue({
      ok: true,
      plan: plan({
        reason: "fallback",
        fallbackPrinter: { ...plan().printer, id: "printer-primary", name: "اصلی" },
      }),
    } as never);
    const response = await POST(request({ job: { type: "test", kind: "receipt" } }));
    expect(await response.json()).toMatchObject({ route: "fallback", fallbackFromPrinterId: "printer-primary" });
  });

  it("maps a render failure to 502 render_failed and logs it", async () => {
    vi.mocked(renderService.preparePrint).mockRejectedValue(new Error("chromium gone") as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(request({ printerId: "printer-1", job: { type: "test", kind: "receipt" } }));
    errorSpy.mockRestore();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "render_failed" });
  });
});
