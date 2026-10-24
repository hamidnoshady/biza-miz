import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as purchaseService from "@/lib/purchase-service";
import * as reportPage from "@/lib/report-page-query";
import { GET, POST } from "./route";

/**
 * Scoped to this session's change: `POST /api/inventory/purchases` passing
 * `invoiceAssetId` (migration 0179) through to `createDraftPurchase` — the
 * cross-tenant re-validation itself lives in, and is proven against a real
 * database by, `purchase-service.ts`
 * (`integration/purchase-invoice-asset.integration.test.ts`); this only pins
 * that the route forwards the right shape and maps the service's error back.
 * The route's pre-existing GET/line-validation behaviour is untouched by
 * this change and out of scope here.
 */

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/setup-state", () => ({
  resolveActiveLocation: vi.fn(),
}));

vi.mock("@/lib/purchase-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/purchase-service")>();
  return { ...actual, createDraftPurchase: vi.fn() };
});

vi.mock("@/lib/report-page-query", () => ({
  queryReportPage: vi.fn(),
}));

vi.mock("@/lib/vat-policy-service", () => ({
  getBusinessVatPercent: vi.fn().mockResolvedValue(10),
}));

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const LOCATION = { id: "loc-1" };

function req(body: unknown): NextRequest {
  return new Request("http://localhost:3000/api/inventory/purchases", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(LOCATION as never);
  vi.mocked(purchaseService.createDraftPurchase).mockResolvedValue({ id: "purchase-1", total: "500000" } as never);
});

describe("POST /api/inventory/purchases — invoiceAssetId (migration 0179)", () => {
  it("forwards a string invoiceAssetId and this business's id to createDraftPurchase", async () => {
    const res = await POST(req({ items: [{ inventoryItemId: "i1", purchaseQty: "1", totalCost: "1000" }], invoiceAssetId: "asset-9" }));
    expect(res.status).toBe(200);
    expect(purchaseService.createDraftPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: SESSION.businessId, invoiceAssetId: "asset-9", locationId: LOCATION.id }),
    );
  });

  it("normalizes an absent or non-string invoiceAssetId to null rather than undefined", async () => {
    await POST(req({ items: [] }));
    expect(purchaseService.createDraftPurchase).toHaveBeenCalledWith(expect.objectContaining({ invoiceAssetId: null }));

    await POST(req({ items: [], invoiceAssetId: 12345 }));
    expect(purchaseService.createDraftPurchase).toHaveBeenCalledWith(expect.objectContaining({ invoiceAssetId: null }));
  });

  it("maps invoice_asset_not_found from the service to its own 404, same as any other PurchaseServiceError", async () => {
    const { PurchaseServiceError } = await import("@/lib/purchase-service");
    vi.mocked(purchaseService.createDraftPurchase).mockRejectedValue(
      new PurchaseServiceError("invoice_asset_not_found", 404),
    );
    const res = await POST(req({ items: [], invoiceAssetId: "cross-tenant-asset" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("invoice_asset_not_found");
  });

  it("409s no_location before ever calling createDraftPurchase", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null);
    const res = await POST(req({ items: [] }));
    expect(res.status).toBe(409);
    expect(purchaseService.createDraftPurchase).not.toHaveBeenCalled();
  });
});

describe("GET /api/inventory/purchases — filters, pagination, totals and CSV (issue #915 phase 3)", () => {
  beforeEach(() => {
    vi.mocked(reportPage.queryReportPage).mockResolvedValue({
      rows: [],
      total: 0,
      summary: { goodsRial: "0", vatRial: "0" },
      pagination: { page: 1, pageSize: 50, total: 0, pages: 1 },
    } as never);
  });

  function get(search = ""): NextRequest {
    return new Request(`http://localhost:3000/api/inventory/purchases${search}`) as unknown as NextRequest;
  }

  it("rejects malformed filters with their own codes instead of raw Postgres cast errors", async () => {
    expect((await (await GET(get("?supplierId=sup-1"))).json()).error).toBe("invalid_supplier");
    expect((await (await GET(get("?status=bogus"))).json()).error).toBe("invalid_status");
    expect((await (await GET(get("?dateFrom=2026-13-01"))).json()).error).toBe("invalid_date");
    expect((await (await GET(get("?itemId=item-1"))).json()).error).toBe("invalid_item");
    expect((await (await GET(get(`?invoiceNumber=${"x".repeat(65)}`))).json()).error).toBe("invalid_filter");
    expect((await (await GET(get("?page=0"))).json()).error).toBe("invalid_page");
    expect((await (await GET(get("?format=xlsx"))).json()).error).toBe("invalid_format");
    expect(reportPage.queryReportPage).not.toHaveBeenCalled();
  });

  it("passes every filter to the paginated query and echoes pagination + totals", async () => {
    const SUPPLIER = "0b2a9c6e-3d4f-4a5b-9c8d-fedcba987654";
    const ITEM = "7d4f8a3e-1b2c-4d5e-8f90-123456789abc";
    const res = await GET(
      get(`?status=received&supplierId=${SUPPLIER}&dateFrom=2026-01-01&dateTo=2026-01-31&invoiceNumber=F%25-9&itemId=${ITEM}&page=2`),
    );
    expect(res.status).toBe(200);
    const [sql, params, options] = vi.mocked(reportPage.queryReportPage).mock.calls[0];
    expect(sql).toContain("p.status = $2::purchase_status");
    expect(sql).toContain("p.supplier_id = $3::uuid");
    expect(sql).toContain("p.supplier_invoice_number ILIKE $6 ESCAPE '!'");
    expect(sql).toContain("li.inventory_item_id = $7");
    // The typed "%" is escaped — it matches literally, not as a wildcard.
    expect(params).toEqual(["loc-1", "received", SUPPLIER, "2026-01-01", "2026-01-31", "%F!%-9%", ITEM]);
    expect(options).toMatchObject({ page: 2 });
    const body = await res.json();
    expect(body.totals).toEqual({ count: 0, goodsRial: "0", vatRial: "0" });
    expect(body.pagination).toEqual({ page: 1, pageSize: 50, total: 0, pages: 1 });
  });

  it("?format=csv exports the full filtered set with Shamsi dates and exact Rial digits", async () => {
    vi.mocked(reportPage.queryReportPage).mockResolvedValue({
      rows: [
        {
          id: "p1", status: "received", total: "9007199254740993", note: null, supplier_id: null,
          ordered_at: null, received_at: null, created_at: "2026-01-05T08:00:00Z", purchase_date: "2026-01-05",
          supplier_invoice_number: "+F-1", supplier_invoice_date: "2026-01-04", vat_amount: "45000",
          payment_terms_days: null, payment_due_date: null, settlement_method: "credit", supplier_name: "Acme",
        },
      ],
      total: 1,
      summary: { goodsRial: "9007199254740993", vatRial: "45000" },
      pagination: null,
    } as never);
    const res = await GET(get("?format=csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    // Export runs unpaginated — the whole filtered history, not one page.
    expect(vi.mocked(reportPage.queryReportPage).mock.calls[0][2]).not.toHaveProperty("page");
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = await res.text();
    expect(text).toContain('"9007199254740993"'); // exact money text
    expect(text).toContain('"۱۴۰۴/۱۰/۱۵"'); // purchase_date in Shamsi, never Gregorian
    expect(text).not.toContain("2026-01-05"); // no raw ISO dates in the export
    expect(text).toContain("\"'+F-1\""); // formula-injection guard
  });
});
