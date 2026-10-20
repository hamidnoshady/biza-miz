import { describe, expect, it } from "vitest";
import { computeOverviewFigures, outstandingNetRial } from "./ledger-reports-service";

const big = "9007199254740993"; // 2^53+1
describe("ledger overview KPI semantics (#912)", () => {
  it("keeps exact Rial past MAX_SAFE_INTEGER", () => {
    const f = computeOverviewFigures([{ debit: big, credit: "0", plDebit: "0", plCredit: "0", type: "asset", role: "bank" }]);
    expect(f.bank.toString()).toBe(big);
    expect(f.cashAndBank.toString()).toBe(big);
  });
  it("P&L uses non-closing columns so a closed year retains performance", () => {
    // debit/credit include closing offset (net 0); pl* exclude it.
    const f = computeOverviewFigures([
      { debit: "1000", credit: "1000", plDebit: "0", plCredit: "1000", type: "revenue", role: null },
      { debit: "400", credit: "400", plDebit: "400", plCredit: "0", type: "expense", role: null },
    ]);
    expect(f.revenue.toString()).toBe("1000");
    expect(f.expenses.toString()).toBe("400");
    expect(f.netIncome.toString()).toBe("600");
  });
  it("outstanding cost exposure prorates returns and zeroes full returns", () => {
    expect(outstandingNetRial("1000", "4", "1")).toBe("750");
    expect(outstandingNetRial("1000", "4", "4")).toBe("0");
    expect(outstandingNetRial("1000", "4", "0")).toBe("1000");
  });
});
