import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accountingSectionNeedsAccountList } from "./accounting-manager-policy";

const managerSource = readFileSync(new URL("./accounting-manager.tsx", import.meta.url), "utf8");

describe("AccountingManager account-list loading", () => {
  it("only requires the chart for sections that consume it", () => {
    expect(accountingSectionNeedsAccountList("manual")).toBe(true);
    expect(accountingSectionNeedsAccountList("expenses")).toBe(true);
    expect(accountingSectionNeedsAccountList("fixed-assets")).toBe(true);
    expect(accountingSectionNeedsAccountList("multicurrency")).toBe(true);
    expect(accountingSectionNeedsAccountList("trial-balance")).toBe(false);
    expect(accountingSectionNeedsAccountList("entries")).toBe(false);
  });

  it("guards both the request and the loading gate with that section policy", () => {
    expect(managerSource).toMatch(/if\s*\(requiresAccounts\)\s*loadAccounts\(\)/);
    expect(managerSource).toMatch(/requiresAccounts\s*&&\s*!accounts\s*\?/);
    expect(managerSource).not.toMatch(/useEffect\(loadAccounts,\s*\[loadAccounts\]\)/);
  });

  /**
   * Issue #909 §13 — the chart-load gate must only ever replace the section
   * `body`, never the page chrome around it (the sub-group chip row, the
   * error banner). A page-wide early `return` for a per-section prerequisite
   * is exactly the "waterfall blocking unrelated sections" defect; see
   * `accounting-manager-chart-scoping.test.tsx` for the rendered behavior
   * this source shape is relied on to produce.
   */
  it("never lets the chart gate early-return the whole component", () => {
    expect(managerSource).not.toMatch(/if\s*\(requiresAccounts\s*&&\s*!accounts\)\s*\{/);
    expect(managerSource).toMatch(/const\s+chartGateBody\s*=/);
    expect(managerSource).toMatch(/const\s+body\s*=\s*chartGateBody\s*\?\?/);
  });
});
