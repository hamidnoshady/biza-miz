// GH #1567 Phase 6D — the consignment accounting contract, as arithmetic.
import { describe, expect, it } from "vitest";
import {
  ConsignmentRuleError,
  allowedActions,
  assertAllowed,
  consignmentShares,
  contractStatus,
  onHand,
  outstandingPayable,
  returnShares,
  validateContract,
} from "./fashion-consignment";

const OWNER_PRICE = { terms: "owner_price" as const, ownerUnitPriceRial: 600_000, commissionBp: null };
const COMMISSION = { terms: "commission" as const, ownerUnitPriceRial: null, commissionBp: 2_500 };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ConsignmentRuleError ? error.code : String(error);
  }
  return undefined;
}

describe("consignment shares at sale", () => {
  it("owner-price terms: the owner gets the agreed price per unit, the shop keeps the rest", () => {
    expect(consignmentShares(OWNER_PRICE, 2, 1_600_000n)).toEqual({ ownerShareRial: 1_200_000n, commissionRial: 400_000n });
  });

  it("owner-price terms: a sale below the owner's price is refused, never a hidden loss", () => {
    expect(code(() => consignmentShares(OWNER_PRICE, 2, 1_199_999n))).toBe("below_owner_price");
    expect(consignmentShares(OWNER_PRICE, 2, 1_200_000n).commissionRial).toBe(0n);
  });

  it("commission terms: the shop keeps the rate on net, rounded half-up, the owner gets the rest", () => {
    expect(consignmentShares(COMMISSION, 1, 800_000n)).toEqual({ ownerShareRial: 600_000n, commissionRial: 200_000n });
    // 25% of 333,333 = 83,333.25 → 83,333
    const odd = consignmentShares(COMMISSION, 1, 333_333n);
    expect(odd.commissionRial).toBe(83_333n);
    expect(odd.ownerShareRial + odd.commissionRial).toBe(333_333n);
  });

  it("the two shares always sum to net exactly", () => {
    for (const net of [0n, 1n, 7n, 999_999n, 12_345_678n]) {
      const s = consignmentShares({ ...COMMISSION, commissionBp: 3_333 }, 3, net);
      expect(s.ownerShareRial + s.commissionRial).toBe(net);
    }
  });
});

describe("consignment shares on return", () => {
  const sale = { quantity: 3, ownerShareRial: 1_000_000n, commissionRial: 200_001n };

  it("partial returns prorate cumulatively, and a full return reverses exactly", () => {
    const first = returnShares(sale, 0, 1);
    const second = returnShares(sale, 1, 1);
    const third = returnShares(sale, 2, 1);
    expect(first.ownerShareRial + second.ownerShareRial + third.ownerShareRial).toBe(sale.ownerShareRial);
    expect(first.commissionRial + second.commissionRial + third.commissionRial).toBe(sale.commissionRial);
    expect(first.ownerShareRial).toBe(333_333n);
  });

  it("refuses returning more than was sold", () => {
    expect(code(() => returnShares(sale, 2, 2))).toBe("return_exceeds_sale");
  });
});

describe("contract validation and state", () => {
  const base = { reference: "C-1", consignorId: "o", startsOn: "2026-11-01", expiresOn: "2027-01-31", lines: [{ itemId: "a", ...OWNER_PRICE }] };

  it("accepts a well-formed contract and rejects bad terms, dates and duplicates", () => {
    expect(() => validateContract(base)).not.toThrow();
    expect(code(() => validateContract({ ...base, lines: [] }))).toBe("contract_has_no_lines");
    expect(code(() => validateContract({ ...base, expiresOn: "2026-10-01" }))).toBe("expiry_before_start");
    expect(code(() => validateContract({ ...base, lines: [base.lines[0], base.lines[0]] }))).toBe("duplicate_line");
    expect(code(() => validateContract({ ...base, lines: [{ itemId: "a", terms: "owner_price", ownerUnitPriceRial: 0, commissionBp: null }] }))).toBe("invalid_owner_price");
    expect(code(() => validateContract({ ...base, lines: [{ itemId: "a", terms: "commission", ownerUnitPriceRial: null, commissionBp: 10_001 }] }))).toBe("invalid_commission");
    expect(code(() => validateContract({ ...base, lines: [{ itemId: "a", terms: "commission", ownerUnitPriceRial: 5, commissionBp: 100 }] }))).toBe("terms_conflict");
  });

  it("derives open / expired / closed from dates, and gates actions by it", () => {
    expect(contractStatus({ closedAt: null, expiresOn: "2026-12-31" }, "2026-12-31")).toBe("open");
    expect(contractStatus({ closedAt: null, expiresOn: "2026-12-31" }, "2027-01-01")).toBe("expired");
    expect(contractStatus({ closedAt: "2026-12-01", expiresOn: null }, "2026-12-02")).toBe("closed");
    expect(allowedActions("expired")).not.toContain("sell");
    expect(allowedActions("expired")).not.toContain("receive");
    expect(allowedActions("expired")).toContain("return_to_owner");
    expect(code(() => assertAllowed("expired", "sell"))).toBe("contract_expired");
    expect(code(() => assertAllowed("closed", "receive"))).toBe("contract_closed");
    expect(() => assertAllowed("closed", "settle")).not.toThrow();
  });

  it("on-hand and outstanding payable follow the movement totals", () => {
    expect(onHand({ received: 10, sold: 6, customerReturned: 1, returnedToOwner: 2 })).toBe(3);
    expect(outstandingPayable({ shareSoldRial: 3_600_000n, shareReturnedRial: 600_000n, settledRial: 1_000_000n })).toBe(2_000_000n);
  });
});
