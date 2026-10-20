import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as stockService from "@/lib/retail-stock-service";
import * as reportPage from "@/lib/report-page-query";
import { GET, POST } from "./route";

/**
 * Issue #915 — the retail purchase route's contract at the HTTP edge: every
 * malformed input is a stable, coded 400 *before* any database work (never a
 * raw Postgres cast error surfaced as a 500), money crosses as decimal text
 * exactly, and an idempotent replay never enqueues a second Holoo document.
 * The database-backed behaviour (stock, settlement postings, races) is
 * proven in `integration/retail-purchase-integrity.integration.test.ts`.
 */

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/setup-state", () => ({
  resolveActiveLocation: vi.fn(),
}));

vi.mock("@/lib/vat-policy-service", () => ({
  getBusinessVatPercent: vi.fn().mockResolvedValue(10),
}));

vi.mock("@/lib/report-page-query", () => ({
  queryReportPage: vi.fn(),
}));

vi.mock("@/lib/integrations/holoo/outbox-producer", () => ({
  enqueueHolooPurchase: vi.fn(),
}));

const client = { query: vi.fn(), release: vi.fn() };
vi.mock("@/lib/db", () => ({
  getPool: () => ({ connect: async () => client }),
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock("@/lib/retail-stock-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/retail-stock-service")>();
  return { ...actual, receiveItemPurchase: vi.fn(), readItemPurchaseByIdempotencyKey: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const LOCATION = { id: "loc-1" };
const ITEM_ID = "7d4f8a3e-1b2c-4d5e-8f90-123456789abc";
const SUPPLIER_ID = "0b2a9c6e-3d4f-4a5b-9c8d-fedcba987654";

/** 2^53 + 1 — exact only as text. */
const HUGE = "9007199254740993";

const line = (overrides: Record<string, unknown> = {}) => ({ itemId: ITEM_ID, quantity: "1", unitCost: "50000", ...overrides });

function post(body: unknown): NextRequest {
  return new Request("http://localhost:3000/api/stock/purchases", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

function get(search = ""): NextRequest {
  return new Request(`http://localhost:3000/api/stock/purchases${search}`) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(LOCATION as never);
  vi.mocked(stockService.receiveItemPurchase).mockResolvedValue({ id: "purchase-1", total: "50000", duplicate: false } as never);
  client.query.mockResolvedValue({ rows: [] });
});

async function expect400(body: unknown, error: string) {
  const res = await POST(post(body));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe(error);
  expect(stockService.receiveItemPurchase).not.toHaveBeenCalled();
}

describe("POST /api/stock/purchases — stable 400s before any database work (issue #915)", () => {
  it("a member without purchases.manage gets requirePermission's 403 and the service is never touched", async () => {
    // Issue #915 phase 3 — the UI hides the form via canManagePurchases, but
    // the route must refuse on its own: a crafted request from a staff or
    // custom-role session without the grant stops at the permission gate.
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const res = await POST(post({ lines: [line()] }));
    expect(res.status).toBe(403);
    expect(stockService.receiveItemPurchase).not.toHaveBeenCalled();
    const listRes = await GET(get());
    expect(listRes.status).toBe(403);
  });

  it("rejects a malformed body and an empty purchase", async () => {
    await expect400("{not json", "bad_request");
    await expect400({}, "empty_purchase");
    await expect400({ lines: [] }, "empty_purchase");
  });

  it("rejects a line whose itemId is not a UUID or whose quantity is missing", async () => {
    await expect400({ lines: [line({ itemId: "item-1" })] }, "bad_request");
    await expect400({ lines: [line({ quantity: "" })] }, "bad_request");
  });

  it("rejects every non-integer-Rial unit cost shape; accepts decimal text past 2^53 exactly", async () => {
    for (const bad of ["12.5", "-5", "1e20", "", "۱۲۳", 12.5, -5, Number.MAX_SAFE_INTEGER + 2, null, undefined]) {
      await expect400({ lines: [line({ unitCost: bad })] }, "bad_request");
    }

    const res = await POST(post({ lines: [line({ unitCost: HUGE })] }));
    expect(res.status).toBe(200);
    // The text survives verbatim to the service — never through Number().
    expect(vi.mocked(stockService.receiveItemPurchase).mock.calls[0][1]).toMatchObject({
      lines: [expect.objectContaining({ unitCost: HUGE })],
    });
  });

  it("rejects malformed batch dates, supplier ids and idempotency keys with their own codes", async () => {
    await expect400({ lines: [line({ expiryDate: "2026-13-40" })] }, "invalid_date");
    await expect400({ lines: [line({ manufactureDate: "not-a-date" })] }, "invalid_date");
    await expect400({ lines: [line()], supplierId: "sup-1" }, "invalid_supplier");
    await expect400({ lines: [line()], idempotencyKey: "short" }, "invalid_idempotency_key");
    await expect400({ lines: [line()], idempotencyKey: "x".repeat(129) }, "invalid_idempotency_key");
  });

  it("rejects an unknown settlement method and a malformed invoice block", async () => {
    await expect400({ lines: [line()], settlementMethod: "cheque" }, "invalid_settlement_method");
    await expect400({ lines: [line()], invoice: { vatAmount: -1 } }, "invalid_vat_amount");
  });

  it("defaults settlement to credit (the historical behaviour) and forwards an explicit method with the parsed invoice", async () => {
    await POST(post({ lines: [line()] }));
    expect(vi.mocked(stockService.receiveItemPurchase).mock.calls[0][1]).toMatchObject({ settlementMethod: "credit", invoice: null });

    await POST(
      post({
        lines: [line()],
        supplierId: SUPPLIER_ID,
        settlementMethod: "cash",
        invoice: { invoiceNumber: "F-1", invoiceDate: "2026-02-01", vatAmount: 4500 },
      }),
    );
    expect(vi.mocked(stockService.receiveItemPurchase).mock.calls[1][1]).toMatchObject({
      businessId: SESSION.businessId,
      locationId: LOCATION.id,
      supplierId: SUPPLIER_ID,
      settlementMethod: "cash",
      invoice: expect.objectContaining({ invoiceNumber: "F-1", invoiceDate: "2026-02-01", vatAmount: 4500 }),
    });
  });

  it("does not enqueue a second Holoo document on an idempotent replay", async () => {
    const { enqueueHolooPurchase } = await import("@/lib/integrations/holoo/outbox-producer");
    vi.mocked(stockService.receiveItemPurchase).mockResolvedValue({ id: "p1", total: "50000", duplicate: true } as never);
    const res = await POST(post({ lines: [line()], idempotencyKey: "stable-key-123" }));
    expect(res.status).toBe(200);
    expect((await res.json()).purchase.duplicate).toBe(true);
    expect(enqueueHolooPurchase).not.toHaveBeenCalled();
  });

  it("maps an idempotency conflict from the service to a 409", async () => {
    vi.mocked(stockService.receiveItemPurchase).mockRejectedValue(new stockService.RetailIdempotencyConflictError());
    const res = await POST(post({ lines: [line()], idempotencyKey: "stable-key-123" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("idempotency_conflict");
  });
});

describe("GET /api/stock/purchases — server-side filters and exact text money (issue #915)", () => {
  beforeEach(() => {
    vi.mocked(reportPage.queryReportPage).mockResolvedValue({
      rows: [],
      total: 0,
      summary: undefined,
      pagination: { page: 1, pageSize: 50, total: 0, pages: 1 },
    } as never);
  });

  it("rejects malformed filters with their own codes instead of raw cast errors", async () => {
    expect((await GET(get("?supplierId=sup-1"))).status).toBe(400);
    expect((await (await GET(get("?supplierId=sup-1"))).json()).error).toBe("invalid_supplier");
    expect((await (await GET(get("?dateFrom=2026-13-01"))).json()).error).toBe("invalid_date");
    expect((await (await GET(get("?dateTo=junk"))).json()).error).toBe("invalid_date");
    expect((await (await GET(get("?page=0"))).json()).error).toBe("invalid_page");
    expect((await (await GET(get("?page=abc"))).json()).error).toBe("invalid_page");
    expect((await (await GET(get("?status=draft"))).json()).error).toBe("invalid_status");
    expect((await (await GET(get("?itemId=item-1"))).json()).error).toBe("invalid_item");
    expect((await (await GET(get(`?invoiceNumber=${"x".repeat(65)}`))).json()).error).toBe("invalid_filter");
    expect((await (await GET(get(`?sku=${"x".repeat(65)}`))).json()).error).toBe("invalid_filter");
    expect((await (await GET(get("?format=xlsx"))).json()).error).toBe("invalid_format");
    expect(reportPage.queryReportPage).not.toHaveBeenCalled();
  });

  it("passes status, invoice-number (wildcards escaped) and item/SKU filters to the query (issue #915 phase 3)", async () => {
    const res = await GET(get(`?status=received&invoiceNumber=F%25-9&itemId=${ITEM_ID}&sku=AB_1`));
    expect(res.status).toBe(200);
    const [sql, params] = vi.mocked(reportPage.queryReportPage).mock.calls[0];
    expect(sql).toContain("p.status = $2");
    expect(sql).toContain("p.supplier_invoice_number ILIKE $3 ESCAPE '!'");
    expect(sql).toContain("li.item_id = $4");
    expect(sql).toContain("lower(it.sku) = lower($5)");
    // The typed "%" is escaped in the ILIKE pattern — it matches literally,
    // not as a wildcard. SKU is an exact (case-insensitive) match, no pattern.
    expect(params).toEqual([LOCATION.id, "received", "%F!%-9%", ITEM_ID, "AB_1"]);
  });

  it("reports the filtered set's totals as exact text alongside the page", async () => {
    vi.mocked(reportPage.queryReportPage).mockResolvedValue({
      rows: [],
      total: 7,
      summary: { goodsRial: HUGE, vatRial: "45000" },
      pagination: { page: 1, pageSize: 50, total: 7, pages: 1 },
    } as never);
    const body = await (await GET(get())).json();
    expect(body.totals).toEqual({ count: 7, goodsRial: HUGE, vatRial: "45000" });
  });

  it("?format=csv exports the full filtered set with Shamsi dates and exact Rial digits", async () => {
    vi.mocked(reportPage.queryReportPage).mockResolvedValue({
      rows: [
        {
          id: "p1", total: HUGE, vat_amount: "45000", note: 'say "hi"', received_at: "2026-01-05T08:00:00Z",
          status: "received", settlement_method: "bank", supplier_invoice_number: "=F-1",
          supplier_invoice_date: "2026-01-04", payment_due_date: null, supplier_name: "Acme", line_count: "2",
        },
      ],
      total: 1,
      summary: { goodsRial: HUGE, vatRial: "45000" },
      pagination: null,
    } as never);
    const res = await GET(get("?format=csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("purchase-history.csv");
    // Export runs unpaginated — the whole filtered history, not one page.
    expect(vi.mocked(reportPage.queryReportPage).mock.calls[0][2]).not.toHaveProperty("page");
    // UTF-8 BOM on the raw bytes so Excel opens Persian text correctly
    // (text() strips the BOM while decoding, so check the bytes).
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = await res.text();
    expect(text).toContain(`"${HUGE}"`); // exact money text
    expect(text).toContain('"۱۴۰۴/۱۰/۱۵'); // Shamsi (Persian digits), never Gregorian
    expect(text).not.toContain("2026-01-05"); // no raw ISO dates in user-visible export
    expect(text).toContain('"\'=F-1"'); // formula-injection guard
    expect(text).toContain('"say ""hi"""'); // RFC-4180 quoting
  });

  it("passes supplier and date filters to the paginated query and echoes its pagination", async () => {
    const res = await GET(get(`?supplierId=${SUPPLIER_ID}&dateFrom=2026-01-01&dateTo=2026-01-31&page=3`));
    expect(res.status).toBe(200);
    const [sql, params, options] = vi.mocked(reportPage.queryReportPage).mock.calls[0];
    expect(sql).toContain("p.supplier_id = $2");
    expect(params).toEqual([LOCATION.id, SUPPLIER_ID, "2026-01-01", "2026-01-31"]);
    expect(options).toMatchObject({ page: 3 });
    expect((await res.json()).pagination).toEqual({ page: 1, pageSize: 50, total: 0, pages: 1 });
  });

  it("returns a purchase's money fields as the exact text the database produced", async () => {
    vi.mocked(reportPage.queryReportPage).mockResolvedValue({
      rows: [
        {
          id: "p1", total: HUGE, vat_amount: "45000", note: null, received_at: "2026-01-05T08:00:00Z",
          settlement_method: "bank", supplier_invoice_number: "F-1", supplier_invoice_date: "2026-01-04",
          payment_due_date: null, supplier_name: "Acme", line_count: "2",
        },
      ],
      total: 1,
      summary: undefined,
      pagination: { page: 1, pageSize: 50, total: 1, pages: 1 },
    } as never);
    const body = await (await GET(get())).json();
    expect(body.purchases).toEqual([
      expect.objectContaining({
        id: "p1",
        total: HUGE,
        vatAmount: "45000",
        settlementMethod: "bank",
        supplierInvoiceNumber: "F-1",
        lineCount: 2,
      }),
    ]);
    expect(body.vatPercent).toBe(10);
  });
});
