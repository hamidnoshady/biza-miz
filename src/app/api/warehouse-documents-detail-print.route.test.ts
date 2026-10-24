/**
 * Detail and print handlers for **both** families, tested at the route.
 *
 * They share one rule: permission, then the document, then the document's own
 * branch, then — only if that passes — the payload. The order matters more than
 * the check: a handler that authorized *after* reading the lines would still
 * return nothing, but it would have read another branch's data on the way, and
 * a handler that authorized a caller-supplied branch id would be checking the
 * wrong thing entirely.
 *
 * Retail and F&B are asserted side by side here so "retail gets the same
 * treatment" is a test result, not a claim.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as authorizeModule from "@/lib/authorize";
import * as printLib from "@/lib/warehouse-document-print";

const queryMock = vi.fn();

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
  return { ...actual, query: (...args: unknown[]) => queryMock(...args) };
});

vi.mock("@/lib/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authorize")>();
  return {
    ...actual,
    authorize: vi.fn(),
    denialResponse: vi.fn((denied: { status?: number; code?: string }) =>
      NextResponse.json(
        { error: "forbidden", code: denied.code ?? "LOCATION_FORBIDDEN" },
        { status: denied.status ?? 403 },
      ),
    ),
  };
});

const BUSINESS_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const USER_ID = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12";
const LOCATION_A = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const LOCATION_B = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";
const DOC_ID = "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15";

const SESSION = { businessId: BUSINESS_ID, sub: USER_ID, role: "manager" };

async function handlers() {
  const [retailDetail, retailPrint, fnbDetail, fnbPrint] = await Promise.all([
    import("@/app/api/stock/warehouse-documents/[id]/route"),
    import("@/app/api/stock/warehouse-documents/[id]/print/route"),
    import("@/app/api/inventory/warehouse-documents/[id]/route"),
    import("@/app/api/inventory/warehouse-documents/[id]/print/route"),
  ]);
  return {
    retailDetail: retailDetail.GET,
    retailPrint: retailPrint.GET,
    fnbDetail: fnbDetail.GET,
    fnbPrint: fnbPrint.GET,
  };
}

const context = { params: Promise.resolve({ id: DOC_ID }) };

function getRequest(url = "http://localhost/api/x") {
  return { url, nextUrl: new URL(url), headers: { get: () => null } } as unknown as NextRequest;
}

/** A header row for the detail handlers, in the shape both SELECTs return. */
function documentHeader(locationId: string) {
  return {
    id: DOC_ID,
    kind: "receipt",
    location_id: locationId,
    location_name: locationId === LOCATION_A ? "Branch A" : "Branch B",
    recipient: null,
    document_number: "D-1",
    internal_voucher_number: "RCV-1405-00001",
    voucher_number: "RCV-1405-00001",
    business_date: "2026-01-01",
    location_timezone: "Asia/Tehran",
    reversed_of: null,
    reversal_reason: null,
    is_reversal: false,
    note: null,
    total_value_rial: "1000",
    created_at: "2026-01-01T00:00:00Z",
    created_by_name: "Actor",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockReset();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
});

describe("detail routes — branch authorization before the payload", () => {
  const detailCases = [
    ["retail", "retailDetail"],
    ["F&B", "fnbDetail"],
  ] as const;

  it.each(detailCases)("%s: refuses another branch's voucher before reading its lines", async (_label, key) => {
    const handlersByKey = await handlers();
    const handler = handlersByKey[key];
    vi.mocked(authorizeModule.authorize).mockResolvedValue({
      ok: false,
      code: "LOCATION_FORBIDDEN",
      status: 403,
    } as never);
    queryMock.mockResolvedValue({ rows: [documentHeader(LOCATION_B)] });

    const response = await handler(getRequest(), context);

    expect(response.status).toBe(403);
    expect(authorizeModule.authorize).toHaveBeenCalledWith(SESSION, { locationId: LOCATION_B });
    // Only the header lookup ran; the lines/ledger/history reads never did.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it.each(detailCases)("%s: serves its own branch's voucher", async (_label, key) => {
    const handlersByKey = await handlers();
    const handler = handlersByKey[key];
    vi.mocked(authorizeModule.authorize).mockResolvedValue({ ok: true } as never);
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM journal_entries")) return { rows: [] };
      if (sql.includes("FROM domain_events")) return { rows: [] };
      if (sql.includes("FROM warehouse_document_lines") || sql.includes("FROM retail_warehouse_document_lines l2")) {
        return { rows: [] };
      }
      return { rows: [documentHeader(LOCATION_A)] };
    });

    const response = await handler(getRequest(), context);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { document: { id: string }; lines: unknown[] };
    expect(body.document.id).toBe(DOC_ID);
    expect(body.lines).toEqual([]);
    expect(authorizeModule.authorize).toHaveBeenCalledWith(SESSION, { locationId: LOCATION_A });
  });

  it.each(detailCases)("%s: answers 404 for a non-uuid id without reading anything", async (_label, key) => {
    const handlersByKey = await handlers();
    const response = await handlersByKey[key](getRequest(), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(404);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("print routes — branch authorization before rendering", () => {
  const printCases = [
    ["retail", "retailPrint", "retail"],
    ["F&B", "fnbPrint", "fnb"],
  ] as const;

  it.each(printCases)("%s: refuses another branch's sheet", async (_label, key, family) => {
    const handlersByKey = await handlers();
    const loadSpy = vi.spyOn(printLib, "loadPrintableWarehouseDocument").mockResolvedValue({
      locationId: LOCATION_B,
      voucherNumber: "RCV-1405-00002",
    } as never);
    const renderSpy = vi.spyOn(printLib, "renderWarehouseDocumentHtml");
    vi.mocked(authorizeModule.authorize).mockResolvedValue({
      ok: false,
      code: "LOCATION_FORBIDDEN",
      status: 403,
    } as never);

    try {
      const response = await handlersByKey[key](getRequest(), context);
      expect(response.status).toBe(403);
      expect(loadSpy).toHaveBeenCalledWith({ businessId: BUSINESS_ID, documentId: DOC_ID, family });
      expect(authorizeModule.authorize).toHaveBeenCalledWith(SESSION, { locationId: LOCATION_B });
      expect(renderSpy).not.toHaveBeenCalled();
    } finally {
      loadSpy.mockRestore();
      renderSpy.mockRestore();
    }
  });

  it.each(printCases)("%s: renders its own branch's sheet as HTML", async (_label, key, family) => {
    const handlersByKey = await handlers();
    const loadSpy = vi.spyOn(printLib, "loadPrintableWarehouseDocument").mockResolvedValue({
      locationId: LOCATION_A,
      voucherNumber: "RCV-1405-00001",
    } as never);
    const renderSpy = vi
      .spyOn(printLib, "renderWarehouseDocumentHtml")
      .mockResolvedValue("<html>sheet</html>");
    vi.mocked(authorizeModule.authorize).mockResolvedValue({ ok: true } as never);

    try {
      const response = await handlersByKey[key](getRequest(), context);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("sheet");
      expect(loadSpy).toHaveBeenCalledWith({ businessId: BUSINESS_ID, documentId: DOC_ID, family });
    } finally {
      loadSpy.mockRestore();
      renderSpy.mockRestore();
    }
  });

  it.each(printCases)("%s: honours ?download=1 with an attachment disposition", async (_label, key) => {
    const handlersByKey = await handlers();
    const loadSpy = vi.spyOn(printLib, "loadPrintableWarehouseDocument").mockResolvedValue({
      locationId: LOCATION_A,
      voucherNumber: "RCV-1405-00001",
    } as never);
    const renderSpy = vi
      .spyOn(printLib, "renderWarehouseDocumentHtml")
      .mockResolvedValue("<html>sheet</html>");
    vi.mocked(authorizeModule.authorize).mockResolvedValue({ ok: true } as never);

    try {
      const response = await handlersByKey[key](getRequest("http://localhost/api/x?download=1"), context);
      expect(response.headers.get("content-disposition")).toContain('filename="RCV-1405-00001.html"');
    } finally {
      loadSpy.mockRestore();
      renderSpy.mockRestore();
    }
  });

  it.each(printCases)("%s: answers 404 when the document does not exist", async (_label, key) => {
    const handlersByKey = await handlers();
    const loadSpy = vi.spyOn(printLib, "loadPrintableWarehouseDocument").mockResolvedValue(null);

    try {
      const response = await handlersByKey[key](getRequest(), context);
      expect(response.status).toBe(404);
      expect(authorizeModule.authorize).not.toHaveBeenCalled();
    } finally {
      loadSpy.mockRestore();
    }
  });
});
