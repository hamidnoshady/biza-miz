/**
 * The opening step's account contract (issue #1583).
 *
 * These are the decisions that used to live in the browser as
 * `accounts.filter((a) => Number(a.children) === 0)` plus a swallowed fetch
 * error. Pinning them here is what keeps the API's reported state and the
 * screen's rendered state from drifting apart again.
 */
import { describe, expect, it } from "vitest";

import {
  eligibleOpeningAccounts,
  inventoryControlSubtreeIds,
  isEligibleOpeningAccount,
  openingAccountLabel,
  resolveSetupOpeningState,
  SETUP_OPENING_STATES,
  SETUP_OPENING_STATE_MESSAGES,
  type SetupOpeningAccountFacts,
} from "./setup-opening";

function account(
  id: string,
  code: string,
  extra: Partial<SetupOpeningAccountFacts> = {},
): SetupOpeningAccountFacts {
  return {
    id,
    code,
    type: "asset",
    parentId: null,
    isActive: true,
    hasChildren: false,
    ...extra,
  };
}

/** The seeded asset side of a chart: parents plus postable leaves. */
const CHART: SetupOpeningAccountFacts[] = [
  account("a-1", "1000", { hasChildren: true }),
  account("a-11", "1100", { hasChildren: true }),
  account("a-111", "1110", { parentId: "a-11" }),
  account("a-112", "1120", { parentId: "a-11" }),
  account("a-13", "1300", { hasChildren: true }),
  account("a-131", "1301", { parentId: "a-13" }),
  account("a-39", "3900"),
];

describe("opening account eligibility", () => {
  it("keeps active postable leaves and drops parents", () => {
    const eligible = eligibleOpeningAccounts(CHART);
    expect(eligible.map((a) => a.code)).toEqual(["1110", "1120", "3900"]);
  });

  it("drops an archived leaf — it can never be posted to again", () => {
    const eligible = eligibleOpeningAccounts([
      ...CHART,
      account("a-old", "1140", { isActive: false }),
    ]);
    expect(eligible.some((a) => a.code === "1140")).toBe(false);
  });

  it("excludes the whole inventory-control subtree, not only 1300", () => {
    const excluded = inventoryControlSubtreeIds(CHART);
    expect([...excluded].sort()).toEqual(["a-13", "a-131"]);
    expect(eligibleOpeningAccounts(CHART).some((a) => a.code === "1301")).toBe(false);
  });

  it("treats an account with any child as a parent, archived child included", () => {
    expect(
      isEligibleOpeningAccount(account("p", "1200", { hasChildren: true })),
    ).toBe(false);
  });

  it("names a linked bank or till beside its code for the picker", () => {
    expect(openingAccountLabel({ code: "1110", name: "بانک" }, "بانک ملت — جاری")).toBe(
      "1110 — بانک (بانک ملت — جاری)",
    );
    expect(openingAccountLabel({ code: "3900", name: "تراز افتتاحیه" })).toBe(
      "3900 — تراز افتتاحیه",
    );
  });
});

describe("opening state", () => {
  it("has no state without an owner-facing sentence", () => {
    for (const state of SETUP_OPENING_STATES) {
      if (state === "ready") continue;
      expect(SETUP_OPENING_STATE_MESSAGES[state].length).toBeGreaterThan(0);
    }
  });

  it("reports accounting_not_enabled before anything about the chart", () => {
    expect(
      resolveSetupOpeningState({
        accountingEnabled: false,
        chartAccountCount: 0,
        accounts: [],
      }),
    ).toBe("accounting_not_enabled");
  });

  it("distinguishes a missing chart from a chart with no postable leaf", () => {
    expect(
      resolveSetupOpeningState({ accountingEnabled: true, chartAccountCount: 0, accounts: [] }),
    ).toBe("chart_missing");
    expect(
      resolveSetupOpeningState({
        accountingEnabled: true,
        chartAccountCount: 1,
        accounts: [account("parent", "1000", { hasChildren: true })],
      }),
    ).toBe("no_eligible_leaf");
  });

  it("is ready only when a real postable leaf exists", () => {
    expect(
      resolveSetupOpeningState({
        accountingEnabled: true,
        chartAccountCount: CHART.length,
        accounts: CHART,
      }),
    ).toBe("ready");
    // A chart made only of the inventory control subtree has no opening leaf.
    expect(
      resolveSetupOpeningState({
        accountingEnabled: true,
        chartAccountCount: 2,
        accounts: [account("inv", "1300", { hasChildren: true }), account("inv-child", "1301", { parentId: "inv" })],
      }),
    ).toBe("no_eligible_leaf");
  });
});
