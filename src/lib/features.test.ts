import { describe, expect, it } from "vitest";
import {
  featureForApiPath,
  featureForPagePath,
  isLockableFeature,
} from "./features";

describe("featureForApiPath", () => {
  it("maps a gated prefix and its sub-paths to the right flag", () => {
    expect(featureForApiPath("/api/inventory")).toBe("inventory");
    expect(featureForApiPath("/api/inventory/purchases/123")).toBe("inventory");
    expect(featureForApiPath("/api/ledger/entries/drafts")).toBe("ledger");
    expect(
      featureForApiPath("/api/accounting/shareholders/distributions"),
    ).toBe("ledger");
    expect(featureForApiPath("/api/reports/standard/cash_flow")).toBe(
      "reporting",
    );
    expect(featureForApiPath("/api/ai/chat")).toBe("ai_assistant");
    expect(featureForApiPath("/api/connections/telegram")).toBe("integrations");
    expect(featureForApiPath("/api/telegram/session")).toBe("integrations");
  });

  it("maps floor/table routes to reservations, matching the flag's own description", () => {
    expect(featureForApiPath("/api/tables")).toBe("reservations");
    expect(featureForApiPath("/api/table-sessions/abc")).toBe("reservations");
    expect(featureForApiPath("/api/floor/sections")).toBe("reservations");
  });

  it("leaves /api/locations ungated — core branch-resolution plumbing every session needs", () => {
    expect(featureForApiPath("/api/locations/active")).toBeNull();
  });

  it("leaves unmapped prefixes (auth, team, setup, …) ungated", () => {
    expect(featureForApiPath("/api/auth/login")).toBeNull();
    expect(featureForApiPath("/api/team")).toBeNull();
    expect(featureForApiPath("/api/setup/state")).toBeNull();
  });

  it("does not false-positive on a prefix that merely starts with the same characters", () => {
    expect(featureForApiPath("/api/ledgerish")).toBeNull();
  });
});

describe("featureForPagePath", () => {
  it("maps gated canonical workspaces to their flag", () => {
    // Inventory decides food-service inventory versus retail stock on the
    // server, so it intentionally has no generic page-prefix flag here.
    expect(featureForPagePath("/accounting/inventory")).toBeNull();
    expect(featureForPagePath("/accounting/floor")).toBe("reservations");
    expect(featureForPagePath("/accounting/waiter")).toBe("reservations");
    expect(featureForPagePath("/settings/backup")).toBe("backup");
    // Branch management is deliberately ungated here: its settings tab
    // carries `requiredAnyFeature: [multi_location, site_cloud_sync]`, and a
    // single-flag prefix row would lock a sync-only business out.
    expect(featureForPagePath("/settings/branch-management")).toBeNull();
  });

  it("leaves ungated pages (dashboard home, kitchen, POS, team, …) alone", () => {
    expect(featureForPagePath("/dashboard")).toBeNull();
    expect(featureForPagePath("/accounting/kitchen")).toBeNull();
    expect(featureForPagePath("/accounting/pos")).toBeNull();
    expect(featureForPagePath("/settings/team")).toBeNull();
  });
});

describe("isLockableFeature", () => {
  it("marks the two features a business without them may still look at", () => {
    expect(isLockableFeature("ai_assistant")).toBe(true);
    expect(isLockableFeature("integrations")).toBe(true);
  });

  it("leaves every other flag all-or-nothing, so its page keeps redirecting", () => {
    expect(isLockableFeature("inventory")).toBe(false);
    expect(isLockableFeature("ledger")).toBe(false);
    expect(isLockableFeature("reporting")).toBe(false);
    expect(isLockableFeature("multi_location")).toBe(false);
  });

  it("agrees with the page map, so a lockable flag always has a page to preview", () => {
    const lockablePages = featureForPagePath("/ai");
    expect(lockablePages).toBe("ai_assistant");
    expect(featureForPagePath("/websites/wp")).toBe("integrations");
    expect(featureForPagePath("/websites/wp/connections")).toBe(
      "integrations",
    );
    expect(featureForPagePath("/settings/connections/holoo")).toBe(
      "integrations",
    );
    expect(isLockableFeature(featureForApiPath("/api/ai/chat")!)).toBe(true);
  });
});
