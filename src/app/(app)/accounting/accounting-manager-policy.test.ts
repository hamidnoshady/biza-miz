import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accountingSectionNeedsAccountList } from "./accounting-manager-policy";

const managerSource = readFileSync(new URL("./accounting-manager.tsx", import.meta.url), "utf8");

describe("AccountingManager account-list loading", () => {
  it("only requires the chart for sections that consume it", () => {
    expect(accountingSectionNeedsAccountList("manual")).toBe(true);
    expect(accountingSectionNeedsAccountList("expenses")).toBe(true);
    expect(accountingSectionNeedsAccountList("trial-balance")).toBe(false);
    expect(accountingSectionNeedsAccountList("entries")).toBe(false);
  });

  it("guards both the request and the loading gate with that section policy", () => {
    expect(managerSource).toMatch(/if\s*\(requiresAccounts\)\s*loadAccounts\(\)/);
    expect(managerSource).toMatch(/if\s*\(requiresAccounts\s*&&\s*!accounts\)/);
    expect(managerSource).not.toMatch(/useEffect\(loadAccounts,\s*\[loadAccounts\]\)/);
  });
});
