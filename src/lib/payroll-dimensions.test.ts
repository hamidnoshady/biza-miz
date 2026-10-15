import { describe, expect, it } from "vitest";
import {
  allocationTupleKey,
  defaultShare,
  dimensionsFromTupleKey,
  parsePayrollAllocations,
  payrollExpenseSplit,
  type PayrollAllocationShare,
} from "./payroll-dimensions";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const CC1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CC2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PC1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("parsePayrollAllocations", () => {
  it("absent allocations parse to an empty map — every member falls back to their default", () => {
    const parsed = parsePayrollAllocations(undefined);
    expect(parsed.ok && parsed.value.size).toBe(0);
  });

  it("reads shares with dimension ids and labels", () => {
    const parsed = parsePayrollAllocations([
      {
        userId: U1,
        shares: [
          { shareBp: 6000, costCenterId: CC1, label: "شعبه ۱" },
          { shareBp: 4000, costCenterId: CC2, profitCenterId: PC1 },
        ],
      },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const shares = parsed.value.get(U1)!;
    expect(shares).toHaveLength(2);
    expect(shares[0]).toEqual({ shareBp: 6000, dimensions: { cost_center: CC1 }, label: "شعبه ۱" });
    expect(shares[1].dimensions).toEqual({ cost_center: CC2, profit_center: PC1 });
  });

  it("refuses shares that do not total exactly 10 000 bp — never rounded into the run", () => {
    const parsed = parsePayrollAllocations([{ userId: U1, shares: [{ shareBp: 3000 }, { shareBp: 3000 }] }]);
    expect(parsed).toEqual({ ok: false, error: "allocation_must_total_100", field: "allocations.shares" });
  });

  it("refuses malformed ids and non-integer shares by name", () => {
    expect(parsePayrollAllocations([{ userId: "nope", shares: [{ shareBp: 10000 }] }])).toMatchObject({
      ok: false,
      field: "allocations.userId",
    });
    expect(parsePayrollAllocations([{ userId: U1, shares: [{ shareBp: 10000, costCenterId: "x" }] }])).toMatchObject({
      ok: false,
      field: "allocations.shares.costCenterId",
    });
    expect(parsePayrollAllocations([{ userId: U1, shares: [{ shareBp: 50.5 }] }])).toMatchObject({
      ok: false,
      error: "invalid_allocation_share",
    });
  });

  it("refuses a member listed twice", () => {
    const parsed = parsePayrollAllocations([
      { userId: U1, shares: [{ shareBp: 10000 }] },
      { userId: U1, shares: [{ shareBp: 10000 }] },
    ]);
    expect(parsed).toMatchObject({ ok: false, field: "allocations.userId" });
  });
});

describe("payrollExpenseSplit", () => {
  const members = [
    { userId: U1, grossRial: 100_000_001n, employerInsuranceExpenseRial: 7_000_001n },
    { userId: U2, grossRial: 50_000_000n, employerInsuranceExpenseRial: 3_500_000n },
  ];

  it("an unallocated run produces exactly the unattributed bucket — the entry as it always was", () => {
    const split = payrollExpenseSplit(members, () => []);
    expect(split.buckets).toHaveLength(1);
    expect(split.buckets[0].dimensions).toEqual({});
    expect(split.buckets[0].grossRial).toBe(150_000_001n);
    expect(split.buckets[0].employerInsuranceExpenseRial).toBe(10_500_001n);
  });

  it("splits one member across cost centres with exact totals — no rounding drift", () => {
    const shares: PayrollAllocationShare[] = [
      { shareBp: 5000, dimensions: { cost_center: CC1 }, label: null },
      { shareBp: 3000, dimensions: { cost_center: CC2 }, label: null },
      { shareBp: 2000, dimensions: {}, label: null },
    ];
    const split = payrollExpenseSplit([members[0]], () => shares);
    const total = split.buckets.reduce((sum, b) => sum + b.grossRial, 0n);
    expect(total).toBe(members[0].grossRial); // exactly the journal amount
    const employerTotal = split.buckets.reduce((sum, b) => sum + b.employerInsuranceExpenseRial, 0n);
    expect(employerTotal).toBe(members[0].employerInsuranceExpenseRial);
    // 50% of 100 000 001 is not whole: the split is still exact in total.
    // Buckets post unattributed first, then by tuple key.
    const byKey = new Map(split.buckets.map((b) => [allocationTupleKey(b.dimensions), b.grossRial]));
    expect(byKey.get(allocationTupleKey({ cost_center: CC1 }))).toBe(50_000_001n);
    expect(byKey.get(allocationTupleKey({ cost_center: CC2 }))).toBe(30_000_000n);
    expect(byKey.get(allocationTupleKey({}))).toBe(20_000_000n);
  });

  it("groups members that share a tuple into one bucket and keeps distinct tuples apart", () => {
    const sharesOf = (userId: string) =>
      userId === U1
        ? [{ shareBp: 10_000, dimensions: { cost_center: CC1 }, label: null }]
        : [{ shareBp: 10_000, dimensions: { cost_center: CC2 }, label: null }];
    const split = payrollExpenseSplit(members, sharesOf);
    expect(split.buckets.map((b) => allocationTupleKey(b.dimensions))).toEqual([
      allocationTupleKey({ cost_center: CC1 }),
      allocationTupleKey({ cost_center: CC2 }),
    ]);
    expect(split.buckets[0].grossRial).toBe(100_000_001n);
    expect(split.buckets[1].grossRial).toBe(50_000_000n);
  });

  it("records each member's parts for the run's audit snapshot", () => {
    const shares: PayrollAllocationShare[] = [
      { shareBp: 5000, dimensions: { cost_center: CC1 }, label: null },
      { shareBp: 5000, dimensions: { cost_center: CC2 }, label: null },
    ];
    const split = payrollExpenseSplit([members[1]], () => shares);
    expect(split.perMember[0].grossParts).toEqual([25_000_000n, 25_000_000n]);
    expect(split.perMember[0].shares).toHaveLength(2);
  });

  it("a zero-gross member (commission only) contributes nothing and breaks nothing", () => {
    const split = payrollExpenseSplit(
      [{ userId: U1, grossRial: 0n, employerInsuranceExpenseRial: 0n }],
      () => [{ shareBp: 10_000, dimensions: { cost_center: CC1 }, label: null }],
    );
    expect(split.buckets[0].grossRial).toBe(0n);
  });
});

describe("defaultShare / tuple keys", () => {
  it("an empty default is no share at all", () => {
    expect(defaultShare(null)).toEqual([]);
    expect(defaultShare({})).toEqual([]);
    expect(defaultShare({ cost_center: CC1 })).toEqual([{ shareBp: 10_000, dimensions: { cost_center: CC1 }, label: null }]);
  });

  it("tuple keys round-trip and collapse absent kinds", () => {
    const dims = { cost_center: CC1, profit_center: PC1 };
    expect(allocationTupleKey(dims)).toBe(allocationTupleKey({ ...dims, department: undefined }));
    expect(dimensionsFromTupleKey(allocationTupleKey(dims))).toEqual(dims);
    expect(allocationTupleKey(null)).toBe("|||");
  });
});
