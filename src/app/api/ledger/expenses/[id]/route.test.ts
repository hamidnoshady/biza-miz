import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { ExpenseError } from "@/lib/expense-service";
import * as expenseService from "@/lib/expense-service";
import { GET } from "./route";
import { POST as REVERSE } from "./reverse/route";

/**
 * The detail route and the reversal route — issue #832 §1 and §8's HTTP surface.
 *
 * Three properties are worth pinning at the boundary rather than in the service:
 *
 *   - **who may open a record vs who may correct one.** Reading is `ledger.view`
 *     (the auditor's door, the same one the list and the drawer use); reversing
 *     is `finance.expenses_manage`. A route that got this backwards would either
 *     hide the audit trail from the people who must read it or hand correction to
 *     anybody with a till.
 *   - **a foreign id is a 404, not a 403.** The service scopes by tenant in the
 *     query, so another business's expense does not exist here — confirming it
 *     exists would be an oracle.
 *   - **`ExpenseError` carries its own status.** `expense_already_reversed` must
 *     arrive as 409 with the code intact, because the drawer's «این هزینه قبلاً
 *     برگشت خورده است.» is chosen from that code and a 500 would erase it.
 */

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn(), withTenantScope: (h: (...a: unknown[]) => Promise<Response>) => h };
});

vi.mock("@/lib/expense-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/expense-service")>();
  return { ...actual, getExpense: vi.fn(), getExpenseJournalLines: vi.fn(), reverseExpense: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const EXPENSE_ID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

const EXPENSE = {
  id: EXPENSE_ID,
  reference: "EXP-1405-00007",
  expenseDate: "2026-04-01",
  accountId: "acc-1",
  accountCode: "5400",
  accountName: "اجاره",
  paymentAccountId: "acc-2",
  paymentAccountCode: "1100",
  paymentAccountName: "صندوق",
  amount: 50_000_000,
  vatAmount: 0,
  netAmount: 50_000_000,
  vendor: null,
  partyId: null,
  partyName: null,
  locationId: null,
  locationName: null,
  memo: "اجارهٔ فروردین",
  createdByName: "حمید",
  createdAt: "2026-04-01 09:00:00+00",
  receiptAssetId: "asset-1",
  receiptFileName: "rent.jpg",
  status: "active",
  reversedAt: null,
  reversedByName: null,
  reversalExpenseId: null,
  reversalReference: null,
  reversesExpenseId: null,
  reversesExpenseReference: null,
  journalEntryId: "je-1",
};

function request(url = `/api/ledger/expenses/${EXPENSE_ID}`) {
  return { nextUrl: new URL(`http://localhost:3000${url}`) } as unknown as NextRequest;
}

const ctx = { params: Promise.resolve({ id: EXPENSE_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
});

describe("GET /api/ledger/expenses/[id]", () => {
  it("returns the record with the journal lines it posted, under `ledger.view`", async () => {
    vi.mocked(expenseService.getExpense).mockResolvedValue(EXPENSE as never);
    vi.mocked(expenseService.getExpenseJournalLines).mockResolvedValue([
      { accountCode: "5400", accountName: "اجاره", debit: 50_000_000, credit: 0 },
      { accountCode: "1100", accountName: "صندوق", debit: 0, credit: 50_000_000 },
    ]);
    const body = await (await GET(request(), ctx)).json();
    expect(body.expense.reference).toBe("EXP-1405-00007");
    // The lines are what makes this a drawer rather than a repeat of the row:
    // the register and the ledger are read side by side (§8's «linked GL entry»).
    expect(body.journalLines).toHaveLength(2);
    expect(body.journalLines[0]).toMatchObject({ accountCode: "5400", debit: 50_000_000 });
    expect(expenseService.getExpenseJournalLines).toHaveBeenCalledWith("biz-1", "je-1");
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.ledgerView);
  });

  it("skips the lines query when the record has no entry, rather than passing undefined", async () => {
    vi.mocked(expenseService.getExpense).mockResolvedValue({ ...EXPENSE, journalEntryId: null } as never);
    const body = await (await GET(request(), ctx)).json();
    expect(body.journalLines).toEqual([]);
    expect(expenseService.getExpenseJournalLines).not.toHaveBeenCalled();
  });

  it("404s a record this business does not have — including one that exists elsewhere", async () => {
    vi.mocked(expenseService.getExpense).mockResolvedValue(null);
    const res = await GET(request(), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("expense_not_found");
  });
});

describe("POST /api/ledger/expenses/[id]/reverse", () => {
  it("reverses through the service with the session's identity, under the expense capability", async () => {
    vi.mocked(expenseService.reverseExpense).mockResolvedValue({ ...EXPENSE, id: "exp-2" } as never);
    const res = await REVERSE(request(`/api/ledger/expenses/${EXPENSE_ID}/reverse`), ctx);
    expect(res.status).toBe(201);
    expect(expenseService.reverseExpense).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz-1", expenseId: EXPENSE_ID, actorId: "user-1" }),
    );
    // §1 asked for `ledger.approve` here; the shipped rule is the expense
    // capability, and the reason is in the route's comment. This assertion is the
    // decision written down, so a later change is a deliberate edit rather than
    // a silent drift back to a second door.
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.financeExpensesManage);
  });

  it("accepts a bodiless POST — the defaults are the business's today and a derived memo", async () => {
    vi.mocked(expenseService.reverseExpense).mockResolvedValue(EXPENSE as never);
    const noBody = { json: () => Promise.reject(new Error("no body")) } as unknown as NextRequest;
    const res = await REVERSE(noBody, ctx);
    expect(res.status).toBe(201);
    expect(expenseService.reverseExpense).toHaveBeenCalledWith(expect.objectContaining({ memo: null, reversalDate: null }));
  });

  it("passes an explicit date and memo through, without validating them here", async () => {
    // The service owns the rules (future date, locked period); the route only
    // carries intent, so there is exactly one place those checks can be wrong.
    vi.mocked(expenseService.reverseExpense).mockResolvedValue(EXPENSE as never);
    await REVERSE(
      { json: async () => ({ expenseDate: "2026-03-01", memo: "تصحیح حسابدار" }) } as unknown as NextRequest,
      ctx,
    );
    expect(expenseService.reverseExpense).toHaveBeenCalledWith(
      expect.objectContaining({ reversalDate: "2026-03-01", memo: "تصحیح حسابدار" }),
    );
  });

  it("answers 409 when the expense is already reversed, and keeps the code", async () => {
    vi.mocked(expenseService.reverseExpense).mockRejectedValue(new ExpenseError("expense_already_reversed"));
    const res = await REVERSE({ json: async () => ({}) } as unknown as NextRequest, ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("expense_already_reversed");
  });

  it("answers 409 for a row that is itself a reversal", async () => {
    vi.mocked(expenseService.reverseExpense).mockRejectedValue(new ExpenseError("expense_is_reversal"));
    const res = await REVERSE({ json: async () => ({}) } as unknown as NextRequest, ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("expense_is_reversal");
  });

  it("answers 404 for a record that is not this business's", async () => {
    vi.mocked(expenseService.reverseExpense).mockRejectedValue(new ExpenseError("expense_not_found"));
    const res = await REVERSE({ json: async () => ({}) } as unknown as NextRequest, ctx);
    expect(res.status).toBe(404);
  });

  it("turns a fiscal lock from the posting path into 409 with its own code", async () => {
    vi.mocked(expenseService.reverseExpense).mockRejectedValue(new Error("fiscal_period_soft_closed"));
    const res = await REVERSE({ json: async () => ({}) } as unknown as NextRequest, ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("fiscal_period_soft_closed");
  });

  it("re-throws anything it cannot name, so a real fault is not reported as user error", async () => {
    vi.mocked(expenseService.reverseExpense).mockRejectedValue(new Error("connection terminated"));
    await expect(REVERSE({ json: async () => ({}) } as unknown as NextRequest, ctx)).rejects.toThrow(
      "connection terminated",
    );
  });
});
