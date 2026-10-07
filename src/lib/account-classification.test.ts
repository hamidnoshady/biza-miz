import { describe, expect, it } from "vitest";
import { classifyAccounts, isClearing, isUsableLiquidity, type ClassifiableAccount } from "./account-classification";

const acct = (id: string, code: string, type: ClassifiableAccount["type"] = "asset", parentId: string | null = null): ClassifiableAccount => ({
  id, code, type, parentId,
});

describe("classifyAccounts", () => {
  const roles = classifyAccounts([
    acct("root", "1000"),
    acct("cash", "1100", "asset", "root"),
    acct("bank", "1110", "asset", "root"),
    acct("clearing", "1120", "asset", "root"),
    acct("petty", "1130", "asset", "root"),
    acct("bank-melli", "1111", "asset", "root"),
    acct("bank-sub", "BANK-A", "asset", "bank"),
    acct("bank-ext", "11101"),
    acct("ar", "1200"),
    acct("supplier-ar", "1210"),
    acct("vat-in", "1220"),
    acct("platform", "1230"),
    acct("cheques", "1241", "asset", null),
    acct("ap", "2100", "liability"),
    acct("odd", "1199"),
    acct("expense-1100", "1100x", "expense"),
    acct("free", "صندوق شعبه"),
  ]);

  it("separates usable cash, bank and petty cash from card/gateway clearing", () => {
    expect(roles.get("cash")).toBe("cash");
    expect(roles.get("bank")).toBe("bank");
    expect(roles.get("petty")).toBe("petty_cash");
    expect(roles.get("clearing")).toBe("payment_clearing");
    expect(isUsableLiquidity(roles.get("clearing"))).toBe(false);
    expect(isClearing(roles.get("clearing"))).toBe(true);
    expect(isClearing(roles.get("platform"))).toBe(true);
  });

  it("lets a custom descendant inherit its parent's meaning", () => {
    expect(roles.get("bank-sub")).toBe("bank");
    expect(roles.get("bank-melli")).toBe("bank");
    expect(roles.get("bank-ext")).toBe("bank");
  });

  it("keeps recoverable VAT and supplier refunds out of customer receivables", () => {
    expect(roles.get("ar")).toBe("trade_receivable");
    expect(roles.get("cheques")).toBe("trade_receivable");
    expect(roles.get("vat-in")).toBe("vat_receivable");
    expect(roles.get("supplier-ar")).toBe("other_receivable");
    expect(roles.get("ap")).toBe("trade_payable");
  });

  it("never guesses an unrecognised or wrongly typed account into cash", () => {
    expect(roles.get("odd")).toBeNull();
    expect(roles.get("free")).toBeNull();
    expect(roles.get("expense-1100")).toBeNull();
    expect(roles.get("root")).toBeNull();
  });

  it("survives a parent cycle", () => {
    const cyclic = classifyAccounts([acct("a", "X1", "asset", "b"), acct("b", "X2", "asset", "a")]);
    expect(cyclic.get("a")).toBeNull();
  });
});
