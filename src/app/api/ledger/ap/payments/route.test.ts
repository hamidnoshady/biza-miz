import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as apService from "@/lib/ap-service";
import * as installmentService from "@/lib/installments-service";
import * as settings from "@/lib/settings";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn(), withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler };
});
vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});
vi.mock("@/lib/ap-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ap-service")>();
  return { ...actual, payBill: vi.fn() };
});
vi.mock("@/lib/installments-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/installments-service")>();
  return { ...actual, listPaymentsPage: vi.fn(), iteratePaymentsForExport: vi.fn() };
});
vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return { ...actual, getSetting: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1" };
const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";

function postRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(apService.payBill).mockResolvedValue({ id: "payment-1", duplicate: false } as never);
  vi.mocked(installmentService.listPaymentsPage).mockResolvedValue({ rows: [], nextCursor: null, hasMore: false } as never);
  vi.mocked(installmentService.iteratePaymentsForExport).mockReturnValue((async function* () {})() as never);
  vi.mocked(settings.getSetting).mockResolvedValue({ currencyDisplay: "toman" } as never);
});

describe("POST /api/ledger/ap/payments", () => {
  it("requires the A/P management capability and a client idempotency key", async () => {
    const response = await POST(postRequest({ supplierId: SUPPLIER_ID, method: "cash", amount: 100 }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "idempotency_key_required" });
    expect(auth.requirePermission).toHaveBeenCalledWith("finance.payables_manage");
    expect(apService.payBill).not.toHaveBeenCalled();
  });

  it("validates a real ISO calendar date before calling the service", async () => {
    const response = await POST(postRequest({
      supplierId: SUPPLIER_ID,
      method: "cash",
      amount: 100,
      paymentDate: "2025-02-31",
      clientRequestId: "request-1",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_date" });
    expect(apService.payBill).not.toHaveBeenCalled();
  });

  it("passes the key, branch and payment intent to the atomic service", async () => {
    const response = await POST(postRequest({
      supplierId: SUPPLIER_ID,
      method: "cash",
      amount: 100,
      paymentDate: "2025-02-28",
      memo: "  supplier invoice  ",
      clientRequestId: "request-1",
    }));
    expect(response.status).toBe(201);
    expect(apService.payBill).toHaveBeenCalledWith({
      businessId: "biz-1",
      locationId: "loc-1",
      supplierId: SUPPLIER_ID,
      method: "cash",
      amount: 100,
      paymentDate: "2025-02-28",
      memo: "supplier invoice",
      clientRequestId: "request-1",
      createdBy: "user-1",
      cashAccountId: null,
      bankReference: null,
    });
  });

  it("answers wrong-typed JSON fields with 400s instead of throwing", async () => {
    const valid = { supplierId: SUPPLIER_ID, method: "cash", amount: 100, clientRequestId: "request-1" };
    const cases: [Record<string, unknown>, string][] = [
      [{ supplierId: 123 }, "supplier_required"],
      [{ clientRequestId: 456 }, "idempotency_key_required"],
      [{ amount: true }, "invalid_amount"],
      [{ amount: [100] }, "invalid_amount"],
      [{ amount: { rial: 100 } }, "invalid_amount"],
      [{ paymentDate: 20250410 }, "invalid_date"],
      [{ memo: 123 }, "invalid_memo"],
      [{ cashAccountId: 123 }, "invalid_cash_account"],
      [{ bankReference: 123 }, "invalid_bank_reference"],
    ];
    for (const [override, code] of cases) {
      const response = await POST(postRequest({ ...valid, ...override }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: code });
    }
    expect(apService.payBill).not.toHaveBeenCalled();
  });

  it("returns 200 for a matching retried payment", async () => {
    vi.mocked(apService.payBill).mockResolvedValue({ id: "payment-1", duplicate: true } as never);
    const response = await POST(postRequest({
      supplierId: SUPPLIER_ID,
      method: "cash",
      amount: 100,
      clientRequestId: "request-1",
    }));
    expect(response.status).toBe(200);
  });
});

it("keeps GET read-only under ledger.view", async () => {
  const request = { nextUrl: new URL("http://localhost/api/ledger/ap/payments?q=acme") } as unknown as NextRequest;
  const response = await GET(request);
  expect(response.status).toBe(200);
  expect(auth.requirePermission).toHaveBeenCalledWith("ledger.view");
  expect(installmentService.listPaymentsPage).toHaveBeenCalledWith("biz-1", expect.objectContaining({ q: "acme" }));
});

it("streams the whole filtered set as CSV, in the business's display unit", async () => {
  const row = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    date: "2026-10-04",
    method: "cash",
    amount: 50_000,
    memo: null,
    supplierId: SUPPLIER_ID,
    supplierPartyId: null,
    partyName: "فروشگاه بهار",
    voucherNumber: 1,
    locationId: null,
    locationName: null,
    createdAt: "2026-10-04T08:00:00.000Z",
    createdByName: null,
    cashAccountId: null,
    bankReference: null,
    cashAccount: null,
    entryId: null,
    reversedAt: null,
    reversalEntryId: null,
    reversalDate: null,
  };
  const second = { ...row, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", voucherNumber: 2 };
  vi.mocked(installmentService.iteratePaymentsForExport).mockReturnValue(
    (async function* () {
      yield [row];
      yield [second];
    })() as never,
  );
  const request = { nextUrl: new URL("http://localhost/api/ledger/ap/payments?format=csv&status=active") } as unknown as NextRequest;
  const response = await GET(request);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="payments.csv"');
  expect(response.headers.get("X-Voucher-Export-Truncated")).toBeNull();
  expect(installmentService.listPaymentsPage).not.toHaveBeenCalled();
  expect(installmentService.iteratePaymentsForExport).toHaveBeenCalledWith("biz-1", expect.objectContaining({ status: "active" }));
  const csv = await response.text();
  expect(csv).toContain("تأمین‌کننده");
  // A Toman business (the mocked setting): converted cells, Toman header.
  expect(csv).toContain("مبلغ (تومان)");
  expect(csv).toContain(",5000,");
  // Both chunks made the file — the export is complete, not a first page.
  expect(csv).toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  expect(csv).toContain("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
});

it("answers 400 JSON for an invalid export filter instead of a broken stream", async () => {
  const { VoucherListError } = await import("@/lib/installments-service");
  vi.mocked(installmentService.iteratePaymentsForExport).mockReturnValue(
    (async function* () {
      throw new VoucherListError("invalid_status");
      yield [];
    })() as never,
  );
  const request = { nextUrl: new URL("http://localhost/api/ledger/ap/payments?format=csv&status=bogus") } as unknown as NextRequest;
  const response = await GET(request);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_status" });
});

it("does not reach payment writes when the permission gate denies access", async () => {
  const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
  const response = await POST(postRequest({}));
  expect(response).toBe(denied);
  expect(apService.payBill).not.toHaveBeenCalled();
});
