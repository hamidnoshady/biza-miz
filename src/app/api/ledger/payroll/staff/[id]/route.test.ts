import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "@/lib/auth";
import * as service from "@/lib/payroll-service";
import { PayrollError } from "@/lib/payroll-errors";
import { PERMISSIONS } from "@/lib/permissions";
import { PATCH } from "./route";

/**
 * Issue #835 §3 — `PATCH …/staff/:id` used to treat a missing `monthlyWage` as
 * `null`, so `{}` (or any body carrying only unrelated properties) silently
 * CLEARED somebody's salary. The route's own comment said missing fields must
 * not clear it; the code did the opposite. Audit F11 then gave a member three
 * more standing terms (two allowances and a fixed deduction), and the same
 * rule holds for all four: only the keys present are written, each must be a
 * real amount, and a body naming none of them changes nothing. These tests
 * drive the real route handler, so they pin the HTTP contract, not just the
 * service.
 */
vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/payroll-service", () => ({ setStaffPayTerms: vi.fn() }));

const session = { businessId: "business-1", sub: "accountant-1", role: "accountant" };
const USER_ID = "0b9f6a52-3c1e-4c2f-9f0a-7a0a1f4f2f11";
const TERMS = ["monthlyWage", "taxableAllowance", "nonTaxableAllowance", "fixedDeduction"] as const;

function patch(body: unknown, raw = false): Promise<Response> {
  const request = new NextRequest(`http://localhost/api/ledger/payroll/staff/${USER_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  return PATCH(request, { params: Promise.resolve({ id: USER_ID }) });
}

const RESULT = {
  changed: true,
  changes: [{ term: "monthlyWage" as const, previousAmount: "1", newAmount: "2" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(service.setStaffPayTerms).mockResolvedValue(RESULT);
});

describe("PATCH /api/ledger/payroll/staff/:id — a missing term never clears a salary", () => {
  it.each([
    ["an empty object", {}],
    ["an unrelated property only", { note: "raise" }],
    ["the wage under a wrong name", { wage: 30000000 }],
    ["the wage in a different case", { MonthlyWage: 30000000 }],
    ["only a reason", { reason: "annual review" }],
  ])("answers 400 for %s and does not touch the wage", async (_name, body) => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(service.setStaffPayTerms).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON null", "null"],
    ["an array", "[]"],
    ["a string", '"30000000"'],
    ["a number", "30000000"],
    ["malformed JSON", "{monthlyWage:"],
    ["an empty body", ""],
  ])("answers 400 for a body that is %s (not a TypeError 500)", async (_name, raw) => {
    const response = await patch(raw, true);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(service.setStaffPayTerms).not.toHaveBeenCalled();
  });

  it("saves an allowance on its own without a wage in the body — and so cannot clear the wage", async () => {
    const response = await patch({ taxableAllowance: 5_000_000 });
    expect(response.status).toBe(200);
    expect(service.setStaffPayTerms).toHaveBeenCalledWith({
      businessId: "business-1",
      userId: USER_ID,
      patch: { taxableAllowance: 5_000_000 },
      actorId: "accountant-1",
      reason: undefined,
    });
    // The service was never handed a wage key, so it has nothing to clear.
    expect(vi.mocked(service.setStaffPayTerms).mock.calls[0][0].patch).not.toHaveProperty("monthlyWage");
  });
});

describe("PATCH /api/ledger/payroll/staff/:id — an explicit null clears the wage, a number saves", () => {
  it("clears the wage on an explicit null", async () => {
    const response = await patch({ monthlyWage: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...RESULT });
    expect(service.setStaffPayTerms).toHaveBeenCalledWith({
      businessId: "business-1",
      userId: USER_ID,
      patch: { monthlyWage: null },
      actorId: "accountant-1",
      reason: undefined,
    });
  });

  it("saves a number, and hands the service the actor and the reason", async () => {
    const response = await patch({ monthlyWage: 35000000, reason: "annual review" });
    expect(response.status).toBe(200);
    expect(service.setStaffPayTerms).toHaveBeenCalledWith({
      businessId: "business-1",
      userId: USER_ID,
      patch: { monthlyWage: 35000000 },
      actorId: "accountant-1",
      reason: "annual review",
    });
  });

  it("saves all four terms in one request, each exactly as sent", async () => {
    await patch({ monthlyWage: 30, taxableAllowance: 4, nonTaxableAllowance: 5, fixedDeduction: 6 });
    expect(service.setStaffPayTerms).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { monthlyWage: 30, taxableAllowance: 4, nonTaxableAllowance: 5, fixedDeduction: 6 } }),
    );
  });

  it("treats a zero as an amount (0), not as missing", async () => {
    await patch({ monthlyWage: 0 });
    expect(service.setStaffPayTerms).toHaveBeenCalledWith(expect.objectContaining({ patch: { monthlyWage: 0 } }));
    await patch({ fixedDeduction: 0 });
    expect(service.setStaffPayTerms).toHaveBeenLastCalledWith(expect.objectContaining({ patch: { fixedDeduction: 0 } }));
  });

  it("ignores unrelated extra properties when a term is named", async () => {
    const response = await patch({ monthlyWage: 5, role: "owner", isActive: false });
    expect(response.status).toBe(200);
    expect(service.setStaffPayTerms).toHaveBeenCalledWith(expect.objectContaining({ patch: { monthlyWage: 5 } }));
  });

  it("lets only the wage be unset: null for an allowance or a deduction is not an amount", async () => {
    for (const term of ["taxableAllowance", "nonTaxableAllowance", "fixedDeduction"]) {
      const response = await patch({ [term]: null });
      expect(response.status, term).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_amount", field: term });
    }
    expect(service.setStaffPayTerms).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/ledger/payroll/staff/:id — only a number is an amount", () => {
  const notAmounts: Array<[string, unknown]> = [
    ["a numeric string", "30000000"],
    ["an empty string", ""],
    ["a word", "abc"],
    ["true", true],
    ["false", false],
    ["an empty array", []],
    ["an array of one number", [5]],
    ["an object", {}],
    ["a nested object", { amount: 5 }],
  ];

  describe.each(TERMS)("for %s", (term) => {
    it.each(notAmounts)("rejects %s with invalid_amount, naming the field", async (_name, value) => {
      const response = await patch({ [term]: value });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_amount", field: term });
      expect(service.setStaffPayTerms).not.toHaveBeenCalled();
    });
  });

  it("refuses the whole request when one term is bad, saving none of them", async () => {
    const response = await patch({ monthlyWage: 5, taxableAllowance: "7" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_amount", field: "taxableAllowance" });
    expect(service.setStaffPayTerms).not.toHaveBeenCalled();
  });

  it("leaves a malformed reason to the service, which refuses it before touching a term", async () => {
    vi.mocked(service.setStaffPayTerms).mockRejectedValue(new PayrollError("invalid_wage_reason"));
    for (const reason of [7, true, [], {}]) {
      const response = await patch({ monthlyWage: 5, reason });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_wage_reason" });
    }
    expect(service.setStaffPayTerms).toHaveBeenCalledTimes(4);
  });

  it("still lets the service range-check a number (negative, fractional, past the safe range)", async () => {
    vi.mocked(service.setStaffPayTerms).mockRejectedValue(new PayrollError("invalid_amount"));
    for (const monthlyWage of [-1, 1.5, 1e21]) {
      const response = await patch({ monthlyWage });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_amount" });
    }
    expect(service.setStaffPayTerms).toHaveBeenCalledTimes(3);
  });
});

describe("PATCH /api/ledger/payroll/staff/:id — authorization and errors", () => {
  it("is gated on payroll.manage, never on a ledger or view capability", async () => {
    await patch({ monthlyWage: 5 });
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.payrollManage);
    expect(auth.requirePermission).not.toHaveBeenCalledWith(PERMISSIONS.payrollView);
  });

  it("propagates a canonical 403 and never reads the body or writes", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({
      session: null,
      error: NextResponse.json({ error: "forbidden", code: "MISSING_PERMISSION" }, { status: 403 }),
    } as never);
    const response = await patch({ monthlyWage: 5 });
    expect(response.status).toBe(403);
    expect(service.setStaffPayTerms).not.toHaveBeenCalled();
  });

  it("maps a missing member to 404 and keeps the code the screen translates", async () => {
    vi.mocked(service.setStaffPayTerms).mockRejectedValue(new PayrollError("user_not_found", 404));
    const response = await patch({ monthlyWage: 5 });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "user_not_found" });
  });

  it("does not swallow an unexpected failure as a 4xx", async () => {
    vi.mocked(service.setStaffPayTerms).mockRejectedValue(new Error("connection reset"));
    await expect(patch({ monthlyWage: 5 })).rejects.toThrow("connection reset");
  });
});
