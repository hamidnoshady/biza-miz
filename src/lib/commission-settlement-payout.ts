/**
 * How a payout divides between members, and how a retry is recognised (issue #869).
 *
 * A payout is a set of per-member allocations against the run's outstanding
 * balance. Each member can receive at most what is still owed to them in that
 * run, so a run can never pay more than it owes, and a member can never be paid
 * twice for the same accrual. Outstanding is derived from the lines and the
 * allocations, never stored, so it cannot drift from them.
 */
import { createHash } from "node:crypto";
import { CommissionSettlementError } from "./commission-settlement-errors";

export interface AllocationRequest {
  employeeId: string;
  /**
   * Positive integer Rial, or `null` for «everything this member is still owed
   * in the run». The server resolves `null` at the moment of the payout, so a
   * screen whose display unit cannot show every Rial still pays the exact sum.
   */
  amount: bigint | null;
}

export interface ResolvedAllocation {
  employeeId: string;
  /** Positive integer Rial. */
  amount: bigint;
}

export interface AllocationPlan {
  /** Sorted by member id, so the same request always writes the same rows in the same order. */
  items: ResolvedAllocation[];
  total: bigint;
}

/**
 * Check a payout request against what each member is still owed in the run.
 * `outstanding` holds every member the run has lines for, including members
 * already fully paid (their value is 0).
 */
export function planAllocations(
  outstanding: ReadonlyMap<string, bigint>,
  requested: readonly AllocationRequest[],
): AllocationPlan {
  if (requested.length === 0) throw new CommissionSettlementError("no_allocations", 400);
  const seen = new Set<string>();
  const items: ResolvedAllocation[] = [];
  let total = 0n;
  for (const item of requested) {
    if (seen.has(item.employeeId)) {
      throw new CommissionSettlementError("duplicate_allocation", 400, { employeeId: item.employeeId });
    }
    seen.add(item.employeeId);
    const owed = outstanding.get(item.employeeId);
    if (owed === undefined) {
      throw new CommissionSettlementError("employee_not_in_run", 400, { employeeId: item.employeeId });
    }
    if (owed <= 0n) {
      throw new CommissionSettlementError("nothing_outstanding", 409, { employeeId: item.employeeId });
    }
    const amount = item.amount ?? owed;
    if (amount <= 0n) {
      throw new CommissionSettlementError("invalid_amount", 400, { employeeId: item.employeeId });
    }
    if (amount > owed) {
      throw new CommissionSettlementError("allocation_exceeds_outstanding", 409, {
        employeeId: item.employeeId,
        outstanding: owed.toString(),
      });
    }
    items.push({ employeeId: item.employeeId, amount });
    total += amount;
  }
  items.sort((a, b) => (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0));
  return { items, total };
}

/**
 * A fingerprint of everything a payout request says. A retry with the same
 * Idempotency-Key must carry the same fingerprint; a different body under a
 * used key is a conflict, not a second payment.
 */
export function payoutRequestHash(input: {
  runId: string;
  allocations: readonly AllocationRequest[];
  paymentAccountId: string | null;
  method: "cash" | "bank" | null;
  /** The date the caller asked for, or null when they left it to the server. Never the resolved date, so a retry tomorrow still matches. */
  paidDate: string | null;
  memo: string | null;
}): string {
  const canonical = {
    runId: input.runId,
    allocations: [...input.allocations]
      .map((item) => ({ employeeId: item.employeeId, amount: item.amount === null ? "all" : item.amount.toString() }))
      .sort((a, b) => (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0)),
    paymentAccountId: input.paymentAccountId,
    method: input.method,
    paidDate: input.paidDate,
    memo: input.memo,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
