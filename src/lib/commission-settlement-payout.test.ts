import { describe, expect, it } from "vitest";
import { CommissionSettlementError } from "./commission-settlement-errors";
import { payoutRequestHash, planAllocations } from "./commission-settlement-payout";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const OWED = new Map<string, bigint>([
  [A, 5000n],
  [B, 10000n],
  [C, 0n],
]);

function refused(fn: () => unknown): CommissionSettlementError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CommissionSettlementError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("planning a payout against what each member is owed", () => {
  it("pays each member up to what the run still owes them, and totals the payout", () => {
    const plan = planAllocations(OWED, [
      { employeeId: B, amount: 4000n },
      { employeeId: A, amount: 5000n },
    ]);
    expect(plan.total).toBe(9000n);
    expect(plan.items).toEqual([
      { employeeId: A, amount: 5000n },
      { employeeId: B, amount: 4000n },
    ]);
  });

  it("resolves «everything owed» to the exact outstanding, whatever unit the screen showed", () => {
    const plan = planAllocations(OWED, [{ employeeId: B, amount: null }]);
    expect(plan).toEqual({ items: [{ employeeId: B, amount: 10000n }], total: 10000n });
  });

  it("refuses to pay a member more than they are owed, and names the outstanding", () => {
    const err = refused(() => planAllocations(OWED, [{ employeeId: A, amount: 5001n }]));
    expect(err).toMatchObject({ message: "allocation_exceeds_outstanding", status: 409, details: { employeeId: A, outstanding: "5000" } });
  });

  it("refuses a member who is already fully paid, and one who is not in the run at all", () => {
    expect(refused(() => planAllocations(OWED, [{ employeeId: C, amount: 1n }])).message).toBe("nothing_outstanding");
    expect(refused(() => planAllocations(OWED, [{ employeeId: "dddddddd-0000-4000-8000-000000000004", amount: 1n }])).message).toBe(
      "employee_not_in_run",
    );
  });

  it("refuses the same member twice in one payout, rather than paying them the sum", () => {
    const err = refused(() =>
      planAllocations(OWED, [
        { employeeId: A, amount: 1000n },
        { employeeId: A, amount: 1000n },
      ]),
    );
    expect(err).toMatchObject({ message: "duplicate_allocation", status: 400 });
  });

  it("refuses an empty payout and a zero or negative amount", () => {
    expect(refused(() => planAllocations(OWED, [])).message).toBe("no_allocations");
    expect(refused(() => planAllocations(OWED, [{ employeeId: A, amount: 0n }])).message).toBe("invalid_amount");
    expect(refused(() => planAllocations(OWED, [{ employeeId: A, amount: -5n }])).message).toBe("invalid_amount");
  });
});

describe("recognising a retry", () => {
  const base = {
    runId: "run-1",
    allocations: [{ employeeId: A, amount: 100n }],
    paymentAccountId: null,
    method: "cash" as const,
    paidDate: "2026-10-09",
    memo: null,
  };

  it("gives the same fingerprint for the same request, whatever order its rows came in", () => {
    const a = payoutRequestHash({ ...base, allocations: [{ employeeId: A, amount: 1n }, { employeeId: B, amount: 2n }] });
    const b = payoutRequestHash({ ...base, allocations: [{ employeeId: B, amount: 2n }, { employeeId: A, amount: 1n }] });
    expect(a).toBe(b);
  });

  it("changes when anything the caller asked for changes: amount, account, date or the all-owed flag", () => {
    const original = payoutRequestHash(base);
    expect(payoutRequestHash({ ...base, allocations: [{ employeeId: A, amount: 101n }] })).not.toBe(original);
    expect(payoutRequestHash({ ...base, method: "bank" })).not.toBe(original);
    expect(payoutRequestHash({ ...base, paidDate: "2026-10-08" })).not.toBe(original);
    expect(payoutRequestHash({ ...base, allocations: [{ employeeId: A, amount: null }] })).not.toBe(original);
  });

  it("keeps the requested date, not a resolved one, so a retry tomorrow still matches", () => {
    const unset = payoutRequestHash({ ...base, paidDate: null });
    expect(unset).toBe(payoutRequestHash({ ...base, paidDate: null }));
    expect(unset).not.toBe(payoutRequestHash(base));
  });
});
