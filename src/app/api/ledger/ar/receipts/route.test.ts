import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as arService from "@/lib/ar-service";
import * as installmentService from "@/lib/installments-service";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn(), withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler };
});
vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});
vi.mock("@/lib/ar-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ar-service")>();
  return { ...actual, receivePayment: vi.fn() };
});
vi.mock("@/lib/installments-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/installments-service")>();
  return { ...actual, listReceiptsPage: vi.fn(), listReceiptsForExport: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1" };
const CUSTOMER_ID = "00000000-0000-4000-8000-000000000001";

function postRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

function getRequest(url: string) {
  return { nextUrl: new URL(url) } as unknown as NextRequest;
}

function receiptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    date: "2026-10-04",
    method: "cash",
    amount: 100_000,
    memo: null,
    partyId: CUSTOMER_ID,
    partyName: "علی",
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
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(arService.receivePayment).mockResolvedValue({ id: "receipt-1", duplicate: false } as never);
  vi.mocked(installmentService.listReceiptsPage).mockResolvedValue({ rows: [], nextCursor: null, hasMore: false } as never);
  vi.mocked(installmentService.listReceiptsForExport).mockResolvedValue({ rows: [], truncated: false } as never);
});

describe("POST /api/ledger/ar/receipts", () => {
  it("requires the A/R management capability and a client idempotency key", async () => {
    const response = await POST(postRequest({ customerId: CUSTOMER_ID, method: "cash", amount: 100 }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "idempotency_key_required" });
    expect(auth.requirePermission).toHaveBeenCalledWith("finance.receivables_manage");
    expect(arService.receivePayment).not.toHaveBeenCalled();
  });

  it("validates a real ISO calendar date before calling the service", async () => {
    const response = await POST(postRequest({
      customerId: CUSTOMER_ID,
      method: "cash",
      amount: 100,
      receiptDate: "2025-02-31",
      idempotencyKey: "request-1",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_date" });
    expect(arService.receivePayment).not.toHaveBeenCalled();
  });

  it("passes the key, branch and receipt intent to the atomic service", async () => {
    const response = await POST(postRequest({
      customerId: CUSTOMER_ID,
      method: "cash",
      amount: 100,
      receiptDate: "2025-02-28",
      memo: "  invoice 12  ",
      idempotencyKey: "request-1",
    }));
    expect(response.status).toBe(201);
    expect(arService.receivePayment).toHaveBeenCalledWith(expect.objectContaining({
      businessId: "biz-1",
      locationId: "loc-1",
      customerId: CUSTOMER_ID,
      method: "cash",
      amount: 100,
      receiptDate: "2025-02-28",
      idempotencyKey: "request-1",
      createdBy: "user-1",
    }));
  });

  it("returns 200 for a matching retried receipt", async () => {
    vi.mocked(arService.receivePayment).mockResolvedValue({ id: "receipt-1", duplicate: true } as never);
    const response = await POST(postRequest({
      customerId: CUSTOMER_ID,
      method: "cash",
      amount: 100,
      idempotencyKey: "request-1",
    }));
    expect(response.status).toBe(200);
  });
});

it("keeps GET read-only under ledger.view", async () => {
  const response = await GET(getRequest("http://localhost/api/ledger/ar/receipts?q=acme"));
  expect(response.status).toBe(200);
  expect(auth.requirePermission).toHaveBeenCalledWith("ledger.view");
  expect(installmentService.listReceiptsPage).toHaveBeenCalledWith("biz-1", expect.objectContaining({ q: "acme" }));
});

it("exports the filtered set as CSV and names a truncation", async () => {
  vi.mocked(installmentService.listReceiptsForExport).mockResolvedValue({
    rows: [receiptRow()],
    truncated: true,
  } as never);
  const response = await GET(getRequest("http://localhost/api/ledger/ar/receipts?format=csv&status=active"));
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("X-Voucher-Export-Truncated")).toBe("20000");
  expect(installmentService.listReceiptsPage).not.toHaveBeenCalled();
  expect(installmentService.listReceiptsForExport).toHaveBeenCalledWith("biz-1", expect.objectContaining({ status: "active" }));
  const csv = await response.text();
  expect(csv).toContain("مبلغ (ریال)");
  expect(csv).toContain(",100000,");
});

it("omits the truncation header when the export is complete", async () => {
  vi.mocked(installmentService.listReceiptsForExport).mockResolvedValue({
    rows: [receiptRow()],
    truncated: false,
  } as never);
  const response = await GET(getRequest("http://localhost/api/ledger/ar/receipts?format=csv"));
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Voucher-Export-Truncated")).toBeNull();
});

it("does not reach receipt writes when the permission gate denies access", async () => {
  const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
  const response = await POST(postRequest({}));
  expect(response).toBe(denied);
  expect(arService.receivePayment).not.toHaveBeenCalled();
});
