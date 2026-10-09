import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as apService from "@/lib/ap-service";
import { ApError } from "@/lib/ap-service";
import { POST } from "./route";

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
  return { ...actual, reverseApPayment: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "approver-1" };
const PAYMENT_ID = "00000000-0000-4000-8000-000000000001";
const CONTEXT = { params: Promise.resolve({ id: PAYMENT_ID }) };

function requestWith(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(apService.reverseApPayment).mockResolvedValue({
    paymentId: PAYMENT_ID,
    reversalEntryId: "reversal-entry-1",
    reversalDate: "2025-04-10",
  });
});

describe("POST /api/ledger/ap/payments/[id]/reverse", () => {
  it("requires ledger.approve, independently of the ordinary payable-management capability", async () => {
    const response = await POST(requestWith({}), CONTEXT);
    expect(response.status).toBe(201);
    expect(auth.requirePermission).toHaveBeenCalledWith("ledger.approve");
    expect(apService.reverseApPayment).toHaveBeenCalledWith({
      businessId: "biz-1",
      locationId: "loc-1",
      paymentId: PAYMENT_ID,
      actorId: "approver-1",
      reversalDate: null,
      memo: undefined,
    });
  });

  it("rejects an impossible reversal date before calling the service", async () => {
    const response = await POST(requestWith({ reversalDate: "2025-02-30" }), CONTEXT);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_date" });
    expect(apService.reverseApPayment).not.toHaveBeenCalled();
  });

  it("maps double-reversal conflicts without mutating the voucher", async () => {
    vi.mocked(apService.reverseApPayment).mockRejectedValue(new ApError("already_reversed", 409));
    const response = await POST(requestWith({}), CONTEXT);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "already_reversed" });
  });

  it("keeps the service behind the high-risk permission gate", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await POST(requestWith({}), CONTEXT);
    expect(response).toBe(denied);
    expect(apService.reverseApPayment).not.toHaveBeenCalled();
  });
});
