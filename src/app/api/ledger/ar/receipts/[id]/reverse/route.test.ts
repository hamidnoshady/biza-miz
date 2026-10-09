import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as arService from "@/lib/ar-service";
import { ArError } from "@/lib/ar-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn(), withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler };
});
vi.mock("@/lib/ar-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ar-service")>();
  return { ...actual, reverseReceipt: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "approver-1" };
const RECEIPT_ID = "00000000-0000-4000-8000-000000000001";
const CONTEXT = { params: Promise.resolve({ id: RECEIPT_ID }) };

function requestWith(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(arService.reverseReceipt).mockResolvedValue({ id: RECEIPT_ID, reversedAt: "2026-10-09T10:00:00Z" } as never);
});

describe("POST /api/ledger/ar/receipts/[id]/reverse", () => {
  it("requires ledger.approve, independently of the ordinary receivables-management capability", async () => {
    const response = await POST(requestWith({}), CONTEXT);
    expect(response.status).toBe(201);
    expect(auth.requirePermission).toHaveBeenCalledWith("ledger.approve");
    expect(arService.reverseReceipt).toHaveBeenCalledWith({
      businessId: "biz-1",
      receiptId: RECEIPT_ID,
      actorId: "approver-1",
      memo: null,
    });
  });

  it("answers a wrong-typed memo with a 400 instead of throwing", async () => {
    const response = await POST(requestWith({ memo: 123 }), CONTEXT);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_memo" });
    expect(arService.reverseReceipt).not.toHaveBeenCalled();
  });

  it("maps double-reversal conflicts without mutating the voucher", async () => {
    vi.mocked(arService.reverseReceipt).mockRejectedValue(new ArError("already_reversed", 409));
    const response = await POST(requestWith({}), CONTEXT);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "already_reversed" });
  });

  it("keeps the service behind the high-risk permission gate", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await POST(requestWith({}), CONTEXT);
    expect(response).toBe(denied);
    expect(arService.reverseReceipt).not.toHaveBeenCalled();
  });
});
