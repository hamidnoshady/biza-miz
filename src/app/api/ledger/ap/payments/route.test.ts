import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as apService from "@/lib/ap-service";
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
vi.mock("@/lib/ap-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ap-service")>();
  return { ...actual, payBill: vi.fn() };
});
vi.mock("@/lib/installments-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/installments-service")>();
  return { ...actual, listPayments: vi.fn() };
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
  vi.mocked(installmentService.listPayments).mockResolvedValue([] as never);
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
      memo: "  supplier invoice  ",
      clientRequestId: "request-1",
      createdBy: "user-1",
    });
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
  expect(installmentService.listPayments).toHaveBeenCalledWith("biz-1", "acme");
});

it("does not reach payment writes when the permission gate denies access", async () => {
  const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
  const response = await POST(postRequest({}));
  expect(response).toBe(denied);
  expect(apService.payBill).not.toHaveBeenCalled();
});
