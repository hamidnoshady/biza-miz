// @vitest-environment node

/**
 * POST /api/sales/invoices — the tender-parsing branch this route added for
 * split-payment support. `createRetailInvoice` and its own tender queue
 * (retail-tenders.ts) are exercised end-to-end by the DB integration suites
 * (integration/retail-split-payment.integration.test.ts and friends); this
 * file is about the HTTP boundary in front of them: what a malformed or
 * over-eager request body gets rejected with, and exactly what tenders array
 * a well-formed one hands to the service.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as industryGuard from "@/lib/industry-guard";
import * as setupState from "@/lib/setup-state";
import * as businessDayService from "@/lib/business-day-service";
import * as invoiceService from "@/lib/retail-invoice-service";
import * as outboxProducer from "@/lib/integrations/holoo/outbox-producer";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: never[]) => unknown) => handler,
  };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn(), getPool: vi.fn() };
});

vi.mock("@/lib/industry-guard", () => ({ getBusinessIndustry: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/business-day-service", () => ({ getBusinessDayStatus: vi.fn() }));
vi.mock("@/lib/integrations/holoo/outbox-producer", () => ({ enqueueHolooSaleForOrder: vi.fn() }));
vi.mock("@/lib/retail-invoice-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/retail-invoice-service")>();
  return { ...actual, createRetailInvoice: vi.fn() };
});

const fakeClient = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeClient.query.mockResolvedValue({ rows: [] });
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: { businessId: "biz-1", sub: "user-1" },
    error: null,
  } as never);
  vi.mocked(industryGuard.getBusinessIndustry).mockResolvedValue("accessories" as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(businessDayService.getBusinessDayStatus).mockResolvedValue(null as never);
  vi.mocked(db.getPool).mockReturnValue({ connect: async () => fakeClient } as never);
  vi.mocked(outboxProducer.enqueueHolooSaleForOrder).mockResolvedValue(undefined as never);
  vi.mocked(invoiceService.createRetailInvoice).mockResolvedValue({
    orderId: "order-1",
    orderNumber: 1,
    total: "109000",
  } as never);
});

const ONE_LINE = [{ kind: "accessory", itemId: "item-1", quantity: "1", vatPercent: 9 }];

describe("POST /api/sales/invoices — tenders", () => {
  it("refuses an invoice with no tenders", async () => {
    const { POST } = await import("./route");
    const res = await POST(request({ lines: ONE_LINE, tenders: [] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_payment" });
    expect(invoiceService.createRetailInvoice).not.toHaveBeenCalled();
  });

  it("refuses more than MAX_RETAIL_TENDERS slices", async () => {
    const { POST } = await import("./route");
    const tenders = Array.from({ length: 11 }, () => ({ method: "cash", amount: 1000 }));
    const res = await POST(request({ lines: ONE_LINE, tenders }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "too_many_tenders" });
  });

  it("refuses an unrecognised settlement method", async () => {
    const { POST } = await import("./route");
    const res = await POST(request({ lines: ONE_LINE, tenders: [{ method: "bitcoin", amount: 1000 }] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_payment_method" });
  });

  it("refuses a zero or non-integer amount", async () => {
    const { POST } = await import("./route");
    const res = await POST(request({ lines: ONE_LINE, tenders: [{ method: "cash", amount: 0 }] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_amount" });

    const res2 = await POST(request({ lines: ONE_LINE, tenders: [{ method: "cash", amount: 100.5 }] }));
    expect(res2.status).toBe(400);
    expect(await res2.json()).toEqual({ error: "invalid_amount" });
  });

  it("refuses a second tender that also omits its amount", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      request({
        lines: ONE_LINE,
        tenders: [{ method: "cash" }, { method: "bank" }],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "too_many_open_tenders" });
    expect(invoiceService.createRetailInvoice).not.toHaveBeenCalled();
  });

  it("refuses a reference over 120 characters", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      request({ lines: ONE_LINE, tenders: [{ method: "cash", amount: 1000, reference: "x".repeat(121) }] }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "payment_reference_too_long" });
  });

  it("refuses a payment way whose settlement class disagrees with the tender's method", async () => {
    const { POST } = await import("./route");
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ settlement: "credit", requires_reference: false, is_active: true }],
    } as never);
    const res = await POST(
      request({ lines: ONE_LINE, tenders: [{ method: "cash", amount: 1000, paymentMethodId: "pm-1" }] }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_payment_method" });
  });

  it("refuses a tender on a way that requires a reference when none was sent", async () => {
    const { POST } = await import("./route");
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ settlement: "card", requires_reference: true, is_active: true }],
    } as never);
    const res = await POST(
      request({ lines: ONE_LINE, tenders: [{ method: "bank", amount: 1000, paymentMethodId: "pm-1" }] }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "payment_reference_required" });
  });

  it("passes exactly one bounded and one open tender through to createRetailInvoice, in order", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      request({
        lines: ONE_LINE,
        tenders: [
          { method: "cash", amount: 50_000, reference: "  " },
          { method: "bank" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(invoiceService.createRetailInvoice).toHaveBeenCalledTimes(1);
    const [, input] = vi.mocked(invoiceService.createRetailInvoice).mock.calls[0];
    expect(input.tenders).toEqual([
      { method: "cash", amount: "50000", paymentMethodId: null, reference: null },
      { method: "bank", amount: undefined, paymentMethodId: null, reference: null },
    ]);
  });
});
