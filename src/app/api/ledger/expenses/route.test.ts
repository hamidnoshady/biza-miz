import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/permissions";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as expenseService from "@/lib/expense-service";
import { ExpenseError } from "@/lib/expense-service";
import { parseExpenseCursor } from "@/lib/expense-input";
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

/** A real uuid: the filters and the cursor are shape-checked, and shape is the point. */
const UUID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

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
  it("reads the register with `ledger.view`, the door a read-only accountant holds", async () => {
    vi.mocked(expenseService.listExpenses).mockResolvedValue({
      expenses: [],
      hasMore: false,
      nextCursor: null,
      totalAmount: 0,
      totalVatAmount: 0,
      totalPaidAmount: 0,
      totalCount: 0,
    } as never);
    const res = await GET(getRequest("?q=coffee"));
    expect(res.status).toBe(200);
    // §3's symmetry: the list is readable without the write capability, so this
    // guard must not be `finance.expenses_manage`.
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.ledgerView);
  });

  it("hands the parsed filters to the service, which is the only filter authority", async () => {
    vi.mocked(expenseService.listExpenses).mockResolvedValue({
      expenses: [],
      hasMore: false,
      nextCursor: null,
      totalAmount: 0,
      totalVatAmount: 0,
      totalPaidAmount: 0,
      totalCount: 0,
    } as never);
    await GET(
      getRequest(`?dateFrom=2026-01-01&dateTo=2026-01-31&status=reversal&locationId=${UUID}`),
    );
    expect(expenseService.listExpenses).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        status: "reversal",
        locationId: UUID,
      }),
    );
  });

  it("encodes nextCursor as the string the client sends back", async () => {
    // The screen puts this value straight into `?cursor=`; handing it the raw
    // `{date, createdAt, id}` triple instead is how «نمایش بیشتر» becomes a
    // request the server's own parser refuses, i.e. a load-more button that never
    // loads. Round-tripping through `parseExpenseCursor` is the contract.
    vi.mocked(expenseService.listExpenses).mockResolvedValue({
      expenses: [],
      hasMore: true,
      nextCursor: { date: "2026-04-01", createdAt: "2026-04-01 09:12:33.123456+00", id: UUID },
      totalAmount: 0,
      totalVatAmount: 0,
      totalPaidAmount: 0,
      totalCount: 0,
    } as never);
    const body = await (await GET(getRequest())).json();
    expect(typeof body.nextCursor).toBe("string");
    expect(parseExpenseCursor(body.nextCursor)).toEqual({
      date: "2026-04-01",
      createdAt: "2026-04-01 09:12:33.123456+00",
      id: UUID,
    });
  });

  it("reports no cursor when the window is not cut off", async () => {
    vi.mocked(expenseService.listExpenses).mockResolvedValue({
      expenses: [],
      hasMore: false,
      nextCursor: null,
      totalAmount: 0,
      totalVatAmount: 0,
      totalPaidAmount: 0,
      totalCount: 0,
    } as never);
    const body = await (await GET(getRequest())).json();
    expect(body.nextCursor).toBeNull();
  });
});

describe("POST /api/ledger/expenses", () => {
  it("writes with `finance.expenses_manage`, not the generic ledger key", async () => {
    vi.mocked(expenseService.recordExpense).mockResolvedValue({ id: "exp-1" } as never);
    await POST(postRequest({ accountId: "a", paymentAccountId: "b", amount: 1, memo: "x" }));
    // §3/§4: this is the capability the import gate, the UI's buttons and the
    // reversal route all key on too — one authorization meaning per business act.
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.financeExpensesManage);
  });

  it("forwards vatAmount and partyId to the service", async () => {
    vi.mocked(expenseService.recordExpense).mockResolvedValue({ id: "exp-1" } as never);
    await POST(
      postRequest({
        accountId: "a",
        paymentAccountId: "b",
        amount: 1_210_000,
        vatAmount: 210_000,
        partyId: "party-1",
        memo: "x",
      }),
    );
    expect(expenseService.recordExpense).toHaveBeenCalledWith(
      expect.objectContaining({ vatAmount: 210_000, partyId: "party-1" }),
    );
  });

  it("prefers an explicit locationId over the member's active branch", async () => {
    // A manager recording another branch's rent must not have it filed under
    // their own till's branch (§6); the active branch is only the default.
    vi.mocked(expenseService.recordExpense).mockResolvedValue({ id: "exp-1" } as never);
    const other = "2b4e28ba-2fa1-11d2-883f-0016d3cca427";
    await POST(postRequest({ accountId: "a", paymentAccountId: "b", amount: 1, memo: "x", locationId: other }));
    expect(expenseService.recordExpense).toHaveBeenCalledWith(expect.objectContaining({ locationId: other }));
    expect(setupState.resolveActiveLocation).not.toHaveBeenCalled();
  });

  it("defaults the branch to the active one when the body says nothing", async () => {
    vi.mocked(expenseService.recordExpense).mockResolvedValue({ id: "exp-1" } as never);
    await POST(postRequest({ accountId: "a", paymentAccountId: "b", amount: 1, memo: "x" }));
    expect(expenseService.recordExpense).toHaveBeenCalledWith(expect.objectContaining({ locationId: "loc-1" }));
  });

  it("turns a fiscal lock into 409 with its own code, never a 500", async () => {
    // The service lets the trigger's error through; the route is what names it.
    vi.mocked(expenseService.recordExpense).mockRejectedValue(new Error("fiscal_period_locked"));
    const res = await POST(postRequest({ accountId: "a", paymentAccountId: "b", amount: 1, memo: "x" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("fiscal_period_locked");
  });

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
