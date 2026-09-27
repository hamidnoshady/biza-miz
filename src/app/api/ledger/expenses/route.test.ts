import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as expenseService from "@/lib/expense-service";
import { ExpenseError } from "@/lib/expense-service";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn(), withTenantScope: (h: (...a: unknown[]) => Promise<Response>) => h };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/expense-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/expense-service")>();
  return { ...actual, listExpenses: vi.fn(), recordExpense: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };

function postRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

function getRequest(qs = "") {
  return { nextUrl: new URL(`http://localhost:3000/api/ledger/expenses${qs}`) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
});

describe("GET /api/ledger/expenses", () => {
  it("returns the filtered list with its true total/count", async () => {
    vi.mocked(expenseService.listExpenses).mockResolvedValue({
      expenses: [],
      hasMore: false,
      totalAmount: 0,
      totalCount: 0,
    } as never);
    const res = await GET(getRequest("?q=coffee"));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/ledger/expenses", () => {
  it("forwards a receiptAssetId from the request body to recordExpense (migration 0177)", async () => {
    vi.mocked(expenseService.recordExpense).mockResolvedValue({ id: "exp-1" } as never);
    const res = await POST(
      postRequest({
        accountId: "acc-expense",
        paymentAccountId: "acc-cash",
        amount: 150000,
        memo: "قهوه و شکر",
        receiptAssetId: "asset-9",
      }),
    );
    expect(res.status).toBe(201);
    expect(expenseService.recordExpense).toHaveBeenCalledWith(
      expect.objectContaining({ receiptAssetId: "asset-9", locationId: "loc-1", businessId: "biz-1" }),
    );
  });

  it("passes receiptAssetId as null when the body omits it, never undefined-vs-absent ambiguity", async () => {
    vi.mocked(expenseService.recordExpense).mockResolvedValue({ id: "exp-2" } as never);
    await POST(postRequest({ accountId: "acc-expense", paymentAccountId: "acc-cash", amount: 1000, memo: "x" }));
    expect(expenseService.recordExpense).toHaveBeenCalledWith(expect.objectContaining({ receiptAssetId: null }));
  });

  it("ignores a non-string receiptAssetId rather than forwarding a malformed value", async () => {
    vi.mocked(expenseService.recordExpense).mockResolvedValue({ id: "exp-3" } as never);
    await POST(
      postRequest({ accountId: "a", paymentAccountId: "b", amount: 1, memo: "x", receiptAssetId: 12345 }),
    );
    expect(expenseService.recordExpense).toHaveBeenCalledWith(expect.objectContaining({ receiptAssetId: null }));
  });

  it("maps ExpenseError (e.g. receipt_asset_not_found) to its own status code", async () => {
    vi.mocked(expenseService.recordExpense).mockRejectedValue(new ExpenseError("receipt_asset_not_found", 404));
    const res = await POST(
      postRequest({ accountId: "a", paymentAccountId: "b", amount: 1, memo: "x", receiptAssetId: "missing" }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("receipt_asset_not_found");
  });

  it("400s on unparseable JSON before ever calling recordExpense", async () => {
    const badRequest = { json: () => Promise.reject(new Error("bad")) } as unknown as NextRequest;
    const res = await POST(badRequest);
    expect(res.status).toBe(400);
    expect(expenseService.recordExpense).not.toHaveBeenCalled();
  });
});
