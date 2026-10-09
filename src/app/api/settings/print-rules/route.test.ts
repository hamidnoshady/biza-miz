/**
 * /api/settings/print-rules — the routing table's only writer (issue #815's
 * "Print Rules are the authoritative routing source", "`templateId` and
 * `templateKey` are both validated", "cross-location IDs refused",
 * "incompatible printer refused").
 *
 * The predicates here are deliberately the resolver's own
 * (`printerAcceptsDocument`, the saved-template lookup scoped to the caller's
 * location), so a rule that saves is a rule that prints. The plan module is
 * mocked for GET's `resolved` view; PUT is exercised against the real
 * validation with the database and permission gate mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as planModule from "@/lib/printing/plan";
import * as setupState from "@/lib/setup-state";
import { GET, PUT } from "./route";

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
  return {
    ...actual,
    resolvePrintPlan: vi.fn(),
    loadRoutablePrinters: vi.fn(),
  };
});

vi.mock("@/lib/print-templates-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/print-templates-service")>();
  return { ...actual, getPrintTemplate: vi.fn() };
});

import * as templates from "@/lib/print-templates-service";

const SESSION = { businessId: "biz-1", sub: "owner-1" };

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [], rowCount: 1 } as never);
  // Upstream of every PUT: the branch's own printers, already narrowed to the
  // routing shape. Individual tests re-mock it with their own inventory.
  vi.mocked(planModule.loadRoutablePrinters).mockResolvedValue({ printers: [], routable: [] } as never);
});

describe("PUT /api/settings/print-rules — the template", () => {
  it("accepts a built-in key of the same document type and stores it as the key", async () => {
    const response = await PUT(request({ documentType: "receipt", templateKey: "thermal58-receipt" }));
    expect(response.status).toBe(200);
    const params = vi.mocked(db.query).mock.calls[0][1] as unknown[];
    expect(params).toEqual(["loc-1", "receipt", "thermal58-receipt", null, null, null]);
  });

  it("refuses a built-in of another document type", async () => {
    const response = await PUT(request({ documentType: "receipt", templateKey: "a4-invoice" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "incompatible_template" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses an unknown key outright — a rule can never name a template nobody can render", async () => {
    vi.mocked(templates.getPrintTemplate).mockResolvedValue(null as never);
    const response = await PUT(request({ documentType: "receipt", templateKey: "not-a-template" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "template_not_found" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("accepts a saved template of THIS location and stores it in template_id", async () => {
    vi.mocked(templates.getPrintTemplate).mockResolvedValue({ id: "tpl-1", docType: "receipt", name: "قالب من" } as never);
    const response = await PUT(request({ documentType: "receipt", templateId: "tpl-1" }));
    expect(response.status).toBe(200);
    expect(templates.getPrintTemplate).toHaveBeenCalledWith("loc-1", "tpl-1");
    const params = vi.mocked(db.query).mock.calls[0][1] as unknown[];
    expect(params.slice(2, 4)).toEqual([null, "tpl-1"]);
  });

  it("cannot reach another location's saved template — the lookup is scoped and the answer is 404", async () => {
    // `getPrintTemplate(locationId, id)` returns null for a row of another
    // branch, which is exactly how a cross-location id is refused.
    vi.mocked(templates.getPrintTemplate).mockImplementation((async (_locationId: string, id: string) =>
      id === "tpl-1" ? { id, docType: "receipt", name: "ours" } : null) as never);
    expect((await PUT(request({ documentType: "receipt", templateId: "tpl-other-branch" }))).status).toBe(404);
    expect((await PUT(request({ documentType: "receipt", templateId: "tpl-1" }))).status).toBe(200);
  });

  it("refuses a saved template of another document type", async () => {
    vi.mocked(templates.getPrintTemplate).mockResolvedValue({ id: "tpl-1", docType: "invoice", name: "فاکتور" } as never);
    expect((await PUT(request({ documentType: "receipt", templateId: "tpl-1" }))).status).toBe(400);
  });

  it("tolerates the pre-unification spelling where a saved id travelled as templateKey", async () => {
    vi.mocked(templates.getPrintTemplate).mockResolvedValue({ id: "tpl-1", docType: "label", name: "برچسب" } as never);
    const response = await PUT(request({ documentType: "label", templateKey: "tpl-1" }));
    expect(response.status).toBe(200);
    const params = vi.mocked(db.query).mock.calls[0][1] as unknown[];
    expect(params.slice(2, 4)).toEqual([null, "tpl-1"]);
  });

  it("clears both template columns when the rule names no template (back to the branch default)", async () => {
    await PUT(request({ documentType: "receipt" }));
    const params = vi.mocked(db.query).mock.calls[0][1] as unknown[];
    expect(params.slice(2, 4)).toEqual([null, null]);
  });
});

describe("PUT /api/settings/print-rules — the printers", () => {
  function routablePrinters() {
    return [
      { id: "p-thermal", name: "صندوق", purpose: "receipt", printerClass: "thermal", isActive: true, isDefault: false, needsReconnect: false, supportsDrawer: true, paper: "thermal80" },
      { id: "p-thermal-2", name: "صندوق ۲", purpose: "receipt", printerClass: "thermal", isActive: true, isDefault: false, needsReconnect: false, supportsDrawer: true, paper: "thermal58" },
      { id: "p-kitchen", name: "آشپزخانه", purpose: "kitchen", printerClass: "thermal", isActive: true, isDefault: false, needsReconnect: false, supportsDrawer: false, paper: "thermal80" },
      { id: "p-page", name: "A4", purpose: "document", printerClass: "page", isActive: true, isDefault: false, needsReconnect: false, supportsDrawer: false, paper: "a4" },
    ];
  }

  beforeEach(() => {
    vi.mocked(planModule.loadRoutablePrinters).mockResolvedValue({ printers: [], routable: routablePrinters() } as never);
  });

  it("accepts a printer that can physically carry the document", async () => {
    expect((await PUT(request({ documentType: "receipt", printerId: "p-thermal" }))).status).toBe(200);
    expect((await PUT(request({ documentType: "invoice", printerId: "p-page" }))).status).toBe(200);
  });

  it("refuses a printer that cannot carry the document, naming it", async () => {
    const pageOnReceipt = await PUT(request({ documentType: "receipt", printerId: "p-page" }));
    expect(pageOnReceipt.status).toBe(400);
    expect(await pageOnReceipt.json()).toMatchObject({ error: "incompatible_printer", printerName: "A4" });

    // Purpose is part of compatibility, not just the paper: a kitchen printer
    // is thermal, but a customer receipt must never come out of the kitchen.
    const kitchenOnReceipt = await PUT(request({ documentType: "receipt", printerId: "p-kitchen" }));
    expect(kitchenOnReceipt.status).toBe(400);
    expect(await kitchenOnReceipt.json()).toMatchObject({ error: "incompatible_printer", printerName: "آشپزخانه" });

    const receiptOnInvoice = await PUT(request({ documentType: "invoice", printerId: "p-thermal" }));
    expect(receiptOnInvoice.status).toBe(400);
  });

  it("refuses a printer of another branch — it is not in this location's routable set", async () => {
    const response = await PUT(request({ documentType: "receipt", printerId: "someone-elses-printer" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "printer_not_found" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses the same printer as both primary and fallback", async () => {
    const response = await PUT(request({ documentType: "receipt", printerId: "p-thermal", fallbackPrinterId: "p-thermal" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "duplicate_fallback_printer" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("validates the fallback with the same compatibility rule as the primary", async () => {
    const response = await PUT(request({ documentType: "receipt", printerId: "p-thermal", fallbackPrinterId: "p-page" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "incompatible_printer", role: "fallback" });
  });

  it("accepts a compatible fallback and upserts the whole rule on the document type", async () => {
    vi.mocked(templates.getPrintTemplate).mockResolvedValue({ id: "tpl-1", docType: "receipt", name: "قالب" } as never);
    const response = await PUT(request({ documentType: "receipt", templateId: "tpl-1", printerId: "p-thermal", fallbackPrinterId: "p-thermal-2" }));
    expect(response.status).toBe(200);
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toContain("ON CONFLICT (location_id, document_type) DO UPDATE");
    expect(params).toEqual(["loc-1", "receipt", null, "tpl-1", "p-thermal", "p-thermal-2"]);
  });
});

describe("PUT guards", () => {
  it("requires settings.manage and returns the gate's error untouched", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    expect((await PUT(request({ documentType: "receipt" }))).status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith("settings.manage");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses an unknown document type and a non-JSON body", async () => {
    expect((await PUT(request({ documentType: "poster" }))).status).toBe(400);
    const bad = { json: async () => Promise.reject(new Error("boom")) } as unknown as NextRequest;
    expect((await PUT(bad)).status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("reports a failed upsert without leaking database detail", async () => {
    vi.mocked(db.query).mockRejectedValue(new Error("deadlock detected") as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await PUT(request({ documentType: "receipt" }));
    errorSpy.mockRestore();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "print_rules_failed" });
  });
});

describe("GET /api/settings/print-rules — rules plus what would actually print", () => {
  it("returns the branch's rules and a resolved view per document type", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [{ document_type: "receipt", template_key: "thermal80-receipt", template_id: null, printer_id: "p-thermal", fallback_printer_id: null }],
      rowCount: 1,
    } as never);
    vi.mocked(planModule.resolvePrintPlan).mockImplementation((async ({ documentType }: { documentType: string }) =>
      documentType === "receipt"
        ? {
            ok: true,
            plan: {
              printer: { id: "p-thermal", name: "صندوق" },
              reason: "rule",
              fallbackPrinter: null,
              templateKey: "thermal80-receipt",
              templateId: null,
              template: { name: "فیش فروش ۸۰ میلی‌متری" },
              templateVersion: 1,
              templateSource: "rule",
            },
          }
        : { ok: false, error: "printer_not_configured" }) as never);

    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rules: unknown[]; resolved: Record<string, Record<string, unknown>> };
    expect(body.rules).toHaveLength(1);
    expect(body.resolved.receipt).toMatchObject({
      ok: true,
      printerName: "صندوق",
      route: "rule",
      templateKey: "thermal80-receipt",
      templateName: "فیش فروش ۸۰ میلی‌متری",
      templateSource: "rule",
    });
    expect(body.resolved.label).toEqual({ ok: false, error: "printer_not_configured" });
  });

  it("resolves with branding skipped — the rules screen is a view, not a print", async () => {
    await GET();
    expect(planModule.resolvePrintPlan).toHaveBeenCalledWith({
      locationId: "loc-1",
      documentType: "receipt",
      includeBranding: false,
    });
  });
});
