/**
 * The billing `include=` contract (issue #755 §17, and the regression that
 * followed it).
 *
 * The route and the page each used to carry their own copy of the key list, and
 * the page sent a key the route refused: `business`. Every tab load therefore
 * answered `400 invalid_include` and the page never left its loading state. The
 * route's own tests could not see it — they call the handler directly — and the
 * page has no fetch harness.
 *
 * These are the assertions that fail on that version: the mapping the page sends
 * must be valid against the set the route accepts, and the always-present
 * `business` key must be nameable rather than refused.
 */
import { describe, expect, it } from "vitest";
import {
  BILLING_ALWAYS_INCLUDED,
  BILLING_INCLUDE_KEYS,
  BILLING_TAB_INCLUDES,
  BILLING_TAB_READY_KEYS,
  isBillingIncludeKey,
} from "./platform-billing-includes";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("the keys the route accepts", () => {
  it("accepts every key every tab sends", () => {
    for (const [tab, keys] of Object.entries(BILLING_TAB_INCLUDES)) {
      expect(keys.length, `tab ${tab} asks for nothing`).toBeGreaterThan(0);
      for (const key of keys) {
        expect(isBillingIncludeKey(key), `tab ${tab} sends a key the route refuses: ${key}`).toBe(
          true,
        );
      }
    }
  });

  it("names `business` as always-present, and it is not a section", () => {
    expect(BILLING_ALWAYS_INCLUDED).toBe("business");
    expect(isBillingIncludeKey(BILLING_ALWAYS_INCLUDED)).toBe(false);
  });

  it("still refuses a key it does not know", () => {
    expect(isBillingIncludeKey("secrets")).toBe(false);
    expect(isBillingIncludeKey("")).toBe(false);
    expect(isBillingIncludeKey("Business")).toBe(false);
  });

  it("keeps the key list free of duplicates and of the always-present name", () => {
    expect(new Set(BILLING_INCLUDE_KEYS).size).toBe(BILLING_INCLUDE_KEYS.length);
    expect(BILLING_INCLUDE_KEYS as readonly string[]).not.toContain(BILLING_ALWAYS_INCLUDED);
  });
});

describe("what each tab waits for", () => {
  it("covers every section that tab requested", () => {
    for (const [tab, keys] of Object.entries(BILLING_TAB_INCLUDES)) {
      const ready = BILLING_TAB_READY_KEYS[tab];
      expect(ready, `tab ${tab} has no ready-keys set`).toBeDefined();
      for (const key of keys) {
        expect(ready, `tab ${tab} requests ${key} but does not wait for it`).toContain(key);
      }
    }
  });

  it("has a ready-keys set for every tab it can include", () => {
    expect(Object.keys(BILLING_TAB_READY_KEYS).sort()).toEqual(
      Object.keys(BILLING_TAB_INCLUDES).sort(),
    );
  });

  it("matches the tabs the page actually renders", () => {
    // The page's `TABS` array is the other half of this contract: a tab with no
    // include mapping would render and then request nothing.
    const page = readFileSync(
      join(process.cwd(), "src/app/platform/businesses/[id]/billing/page.tsx"),
      "utf8",
    );
    const tabsBlock = /const TABS = \[([\s\S]*?)\] as const;/.exec(page);
    expect(tabsBlock, "the billing page has no TABS array").not.toBeNull();
    const rendered = [...tabsBlock![1].matchAll(/key:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.sort()).toEqual(Object.keys(BILLING_TAB_INCLUDES).sort());
  });
});
