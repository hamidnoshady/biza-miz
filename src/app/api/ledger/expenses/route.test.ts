import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/permissions";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as expenseService from "@/lib/expense-service";
import { ExpenseError, MissingLedgerAccountError } from "@/lib/expense-service";
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
      totalOwedAmount: 0,
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

  it("carries the owed figure beside the settled one, never inside it", async () => {
    // The footer says «پرداختی از حساب‌ها», so an owed expense — which credited
    // Accounts Payable and moved no cash — must not be added to it. Its own
    // number has to survive the route, or the screen has no way to say what is
    // still outstanding (audit F11).
    vi.mocked(expenseService.listExpenses).mockResolvedValue({
      expenses: [],
      hasMore: false,
      nextCursor: null,
      totalAmount: 12_000_000,
      totalVatAmount: 0,
      totalPaidAmount: 4_000_000,
      totalOwedAmount: 8_000_000,
      totalCount: 2,
    } as never);
    const body = await (await GET(getRequest())).json();
    expect(body).toMatchObject({ totalAmount: 12_000_000, totalPaidAmount: 4_000_000, totalOwedAmount: 8_000_000 });
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

  it("forwards «پرداخت بعدی» (audit F11): settlement, supplier and due date", async () => {
    vi.mocked(expenseService.recordExpense).mockResolvedValue({ id: "exp-4" } as never);
    const res = await POST(
      postRequest({ accountId: "a", amount: 1, memo: "x", settlement: "credit", supplierId: "sup-1", dueDate: "2026-11-01" }),
    );
    expect(res.status).toBe(201);
    expect(expenseService.recordExpense).toHaveBeenCalledWith(
      expect.objectContaining({ settlement: "credit", supplierId: "sup-1", dueDate: "2026-11-01", paymentAccountId: "" }),
    );
  });

  it("answers a chart without Accounts Payable as a 409 naming the account", async () => {
    vi.mocked(expenseService.recordExpense).mockRejectedValue(new MissingLedgerAccountError("2100"));
    const res = await POST(postRequest({ accountId: "a", amount: 1, memo: "x", settlement: "credit", supplierId: "s" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "ledger_account_missing", code: "2100" });
  });

  it("400s on unparseable JSON before ever calling recordExpense", async () => {
    const badRequest = { json: () => Promise.reject(new Error("bad")) } as unknown as NextRequest;
    const res = await POST(badRequest);
    expect(res.status).toBe(400);
    expect(expenseService.recordExpense).not.toHaveBeenCalled();
  });
});

/*
 * `POST` used to write `Math.trunc(Number(body.amount))` into the service call, so
 * the boundary that takes a person's money figure *changed it* before any rule
 * looked at it: ۱٬۵۰/۷۵ ریال became a posting of ۱٬۵۰۰ and `true` became one rial.
 * The route's job is to hand the value over and let the one amount rule answer;
 * these are the two directions of that contract.
 */
describe("POST /api/ledger/expenses — the amount is forwarded, not repaired", () => {
  it("hands a fractional amount to the service as an amount it must refuse", async () => {
    vi.mocked(expenseService.recordExpense).mockResolvedValue({ id: "exp-1" } as never);
    await POST(postRequest({ accountId: "a", paymentAccountId: "b", amount: 1_500.75, memo: "x" }));
    const forwarded = vi.mocked(expenseService.recordExpense).mock.calls[0]?.[0] as { amount: number };
    // Not 1500. A NaN is a value the service's `invalid_amount` rule rejects; a
    // truncated integer is a ledger entry nobody typed.
    expect(Number.isNaN(forwarded.amount)).toBe(true);
  });

  it("turns a JSON boolean or null into the same refusal, never into one rial", async () => {
    vi.mocked(expenseService.recordExpense).mockResolvedValue({ id: "exp-1" } as never);
    for (const amount of [true, null, "1500.50", "abc", ""]) {
      await POST(postRequest({ accountId: "a", paymentAccountId: "b", amount, memo: "x" }));
    }
    const calls = vi.mocked(expenseService.recordExpense).mock.calls as [{ amount: number }][];
    expect(calls).toHaveLength(5);
    // Every one of them is a refusal the service can name, not a value invented
    // out of the caller's `true`, `null` or half-typed amount.
    expect(calls.map((call) => Number.isNaN(call[0].amount))).toEqual([true, true, true, true, true]);
  });

  it("still accepts a digits-only string, which is what a mobile client sends", async () => {
    vi.mocked(expenseService.recordExpense).mockResolvedValue({ id: "exp-1" } as never);
    await POST(postRequest({ accountId: "a", paymentAccountId: "b", amount: "۱۵۰٬۰۰۰", memo: "x" }));
    const forwarded = vi.mocked(expenseService.recordExpense).mock.calls[0]?.[0] as { amount: number };
    expect(forwarded.amount).toBe(150_000);
  });

  it("answers 400 with the central message, and writes nothing", async () => {
    vi.mocked(expenseService.recordExpense).mockRejectedValue(new ExpenseError("invalid_amount"));
    const res = await POST(postRequest({ accountId: "a", paymentAccountId: "b", amount: 1_500.75, memo: "x" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_amount");
  });
});
